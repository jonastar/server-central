import * as fs from "node:fs/promises";
import type { AgentMode, InstallMechanism, NodeMessage, SystemInfo } from "@central/shared";
import { AGENT_VERSION } from "@central/shared";
import { Agent, type AgentTransport, collectSystemInfo, DEFAULT_DATA_DIR, DEFAULT_INSTALL_DIR, resolveMachineId } from "./agent";
import {
    type InstallPaths,
    type ServiceSpec,
    copySelfToVersionedBin,
    ensureInstallPathsUsable,
    installSystemd as installSystemdUnit,
    isInstalled,
    pointSymlink,
    pruneOldBinaries,
    resolveServicePaths,
    writeManifest,
} from "./self-install";

// ---- CLI argument parsing ----------------------------------------------------

const USAGE = "Usage: sc-server --agent (--config <path> | --control <url> [--alt-control <url>] --token <token> --cert <path> [--mode live|installed])";

/**
 * Resolved launch parameters. The live agent gets these from CLI flags; the
 * installed service gets them from its config file (--config), which also carries
 * the install/data dirs so self-update resolves the same locations.
 */
interface Args {
    control: string;
    altControl: string | null;
    token: string;
    cert: string;
    mode: AgentMode;
    /** Set for an installed agent (from its config file); null for the live agent. */
    installDir: string | null;
    dataDir: string | null;
}

/** Persisted launch config for an installed agent (`--config <path>`). */
interface AgentConfig {
    control: string;
    altControl: string | null;
    token: string;
    /** Path to the cert PEM. */
    cert: string;
    mode: AgentMode;
    installDir: string;
    dataDir: string;
}

async function parseArgs(args: string[]): Promise<Args> {
    let configPath: string | null = null;
    let control: string | null = null;
    let altControl: string | null = null;
    let token: string | null = null;
    let cert: string | null = null;
    let mode: AgentMode = "live";

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--agent") {
            continue;
        }
        else if (args[i] === "--config") {
            configPath = args[++i];
        }
        else if (args[i] === "--control") {
            control = args[++i];
        }
        else if (args[i] === "--alt-control") {
            altControl = args[++i];
        }
        else if (args[i] === "--token") {
            token = args[++i];
        }
        else if (args[i] === "--cert") {
            cert = args[++i];
        }
        else if (args[i] === "--mode") {
            const value = args[++i];
            if (value !== "live" && value !== "installed") {
                console.error(`--mode must be "live" or "installed"`);
                process.exit(1);
            }
            mode = value;
        }
    }

    // --config (installed service) supplies everything, including install/data dirs.
    if (configPath) {
        const cfg = JSON.parse(await Bun.file(configPath).text()) as AgentConfig;
        return {
            control: cfg.control,
            altControl: cfg.altControl,
            token: cfg.token,
            cert: cfg.cert,
            mode: cfg.mode,
            installDir: cfg.installDir,
            dataDir: cfg.dataDir,
        };
    }

    if (!control || !token || !cert) {
        console.error("--control, --token, and --cert are required (or pass --config <path>)");
        console.error(USAGE);
        process.exit(1);
    }

    return { control, altControl, token, cert, mode, installDir: null, dataDir: null };
}

// ---- WebSocket transport -----------------------------------------------------

class WsTransport implements AgentTransport {
    constructor(private readonly ws: WebSocket) { }

    send(msg: NodeMessage): void {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }
}

// ---- Connection --------------------------------------------------------------

const RECONNECT_DELAY_MS = 5_000;

interface Identity {
    token: string;
    machineId: string;
    mode: AgentMode;
    info: SystemInfo;
    certPem: string;
}

// ---- Self-install (live → installed service) ---------------------------------

/** The host-agent role: systemd unit + symlink + versioned-binary base name. */
const AGENT_SPEC: ServiceSpec = { name: "sc-agent", description: "Server Central Agent" };
/** Per-URL deadline for a self-update binary download. Sized so trying every URL
 *  (currently at most two: control + alt) still fits inside the control plane's
 *  30s RPC timeout — a dead endpoint aborts and falls through to the next, and an
 *  all-endpoints failure surfaces as a real error upstream rather than the RPC
 *  silently timing out. The binary is large but transfers in seconds on any real
 *  link, so this only bites unreachable hosts. */
const DOWNLOAD_TIMEOUT_MS = 12_000;

/** Agent install layout: the shared service layout plus the agent's cert + launch
 *  config under the data dir. */
type AgentInstallPaths = InstallPaths & { cert: string; config: string };

/**
 * Resolve where the agent installs: the binary under `installDir` (default
 * /usr/local/bin), and the cert/config/manifest/scratch under `dataDir` (default
 * /var/lib/sc-agent). On an appliance OS where the defaults aren't writable or are
 * mounted noexec, the setup wizard supplies pool paths for both.
 */
function resolveInstallPaths(installDir: string | null, dataDir: string | null): AgentInstallPaths {
    const base = resolveServicePaths(AGENT_SPEC, installDir || DEFAULT_INSTALL_DIR, dataDir || DEFAULT_DATA_DIR);
    return { ...base, cert: `${base.dataDir}/agent.crt`, config: `${base.dataDir}/config.json` };
}

/**
 * Download the agent binary for this platform from the control plane (pinned via
 * the control-plane cert, authenticated by the durable token) into `dest`.
 */
export async function downloadBinary(opts: { control: string; altControl: string | null; certPem: string; token: string; dest: string }): Promise<void> {
    const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux";
    // process.arch is "x64" / "arm64" — exactly the suffix used in the binary names.
    const platform = `${os}-${process.arch}`;
    const urls = [opts.control, ...(opts.altControl ? [opts.altControl] : [])]
        .map((ws) => ws.replace(/^wss:\/\//, "https://").replace(/\/node$/, "") + `/node-binary/${opts.token}/${platform}`);

    console.log(`[update] downloading agent binary (platform ${platform}) to ${opts.dest}; ${urls.length} URL(s) to try`);

    let lastErr: unknown;
    for (const url of urls) {
        // Download to a temp sibling and rename into place, so a failed/partial
        // download never leaves a corrupt binary the symlink could point at.
        const tmp = `${opts.dest}.download-${process.pid}`;
        const startedAt = Date.now();
        try {
            console.log(`[update] fetching ${url} (timeout ${DOWNLOAD_TIMEOUT_MS / 1000}s)`);
            // tls.ca is the control-plane CA cert — the leaf's SAN covers this host,
            // so fetch validates by hostname (Bun-specific fetch option). The signal
            // bounds the attempt: the agent may have connected via the *alt* endpoint
            // (the primary being unreachable from here), and without a deadline fetch
            // black-holes on a dead host's TCP connect — never erroring, never falling
            // through to the next URL. The timeout makes a stuck endpoint abort so we
            // try the alt, and surfaces a real error upstream if every URL fails.
            const res = await fetch(url, { tls: { ca: opts.certPem }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status} ${(await res.text()).trim()}`);
            }
            // Read the body fully via arrayBuffer() rather than streaming the Response
            // straight into Bun.write: the latter can stall after the last chunk
            // arrives (it doesn't finalize on EOF), so the download "completes" on the
            // wire but the write hangs until the AbortSignal.timeout fires. Buffering
            // is fine — the binary is tens of MB. curl on the install path avoids this
            // because it terminates cleanly on Content-Length.
            const bytes = await Bun.write(tmp, await res.arrayBuffer());
            await fs.chmod(tmp, 0o755);
            await fs.rename(tmp, opts.dest);
            console.log(`[update] downloaded ${bytes} bytes from ${url} in ${Date.now() - startedAt}ms`);
            return;
        } catch (err) {
            await fs.rm(tmp, { force: true }).catch(() => { });
            lastErr = err;
            console.warn(`[update] download from ${url} failed after ${Date.now() - startedAt}ms: ${(err as Error)?.message ?? err}`);
        }
    }
    throw new Error(`Failed to download agent binary from ${urls.join(", ")}: ${(lastErr as Error)?.message ?? lastErr}`);
}

/** The command that launches the installed agent from its config file. The systemd
 *  unit and the manual start command both use this; TMPDIR points at the exec-capable
 *  scratch so Bun can extract its native addons even when /tmp is noexec. */
function launchCommand(paths: AgentInstallPaths): string {
    return `TMPDIR=${paths.tmpDir} ${paths.bin} --agent --config ${paths.config}`;
}

/** Install via a systemd unit. Restart=always gives crash recovery and re-execs the
 *  symlink after a self-update. */
async function installSystemd(paths: AgentInstallPaths): Promise<void> {
    await installSystemdUnit(AGENT_SPEC, paths, {
        execStart: `${paths.bin} --agent --config ${paths.config}`,
        env: { TMPDIR: paths.tmpDir },
    });
}

/**
 * "Manual" install: lay down the files but don't fabricate a vendor-specific
 * supervisor. Best-effort start the agent detached now so it reconnects without a
 * reboot, and return the command for the operator to wire into their own init
 * system (e.g. a TrueNAS POSTINIT Init/Shutdown script, or cron @reboot).
 */
function installManual(paths: AgentInstallPaths): string {
    const cmd = launchCommand(paths);
    try {
        // setsid + detach so it survives this (exiting) live agent; failure is fine —
        // the operator can run the returned command themselves.
        Bun.spawn(["/bin/sh", "-c", `setsid ${cmd} >/dev/null 2>&1 &`], { stdout: "ignore", stderr: "ignore" });
    } catch { /* operator runs startCommand manually */ }
    return cmd;
}

/**
 * Promote this live agent to a permanent service: drop the (versioned) binary under
 * the install dir, write the cert + launch config under the data dir, point the
 * stable symlink at the binary, then persist it — a systemd unit (mechanism
 * "systemd") or a returned start command the operator wires up (mechanism "manual")
 * — and exit so the installed agent takes over. Errors out if already installed.
 */
async function installSelf(opts: {
    control: string; altControl: string | null; certPem: string; agentToken: string;
    installDir: string | null; dataDir: string | null; mechanism: InstallMechanism;
}): Promise<{ startCommand: string | null }> {
    if (process.platform !== "linux") {
        throw new Error("Service install is only supported on Linux");
    }
    const paths = resolveInstallPaths(opts.installDir, opts.dataDir);
    if (await isInstalled(AGENT_SPEC, paths)) {
        throw new Error("sc-agent service is already installed");
    }

    await ensureInstallPathsUsable(paths);
    await fs.mkdir(paths.tmpDir, { recursive: true });

    const bin = await copySelfToVersionedBin(paths, AGENT_VERSION);
    await pointSymlink(bin, paths.bin);
    await fs.writeFile(paths.cert, opts.certPem, { mode: 0o600 });

    const config: AgentConfig = {
        control: opts.control,
        altControl: opts.altControl,
        token: opts.agentToken,
        cert: paths.cert,
        mode: "installed",
        installDir: paths.dir,
        dataDir: paths.dataDir,
    };
    await fs.writeFile(paths.config, JSON.stringify(config, null, 2));

    let startCommand: string | null = null;
    if (opts.mechanism === "systemd") {
        await installSystemd(paths);
        console.log("Installed as a systemd service; the installed agent will take over. Exiting live agent.");
    } else {
        startCommand = installManual(paths);
        console.log("Installed (manual); started detached and returned a start command. Exiting live agent.");
    }
    await writeManifest(paths, { mechanism: opts.mechanism });

    // The installed agent connects (mode installed) and takes priority; step aside
    // shortly so the handoff completes. Delay so the success reply is sent first.
    setTimeout(() => process.exit(0), 1500);
    return { startCommand };
}

/**
 * Update this installed agent to `version`: download the new binary, point the
 * stable symlink at it, then exit. The supervisor (systemd Restart=always, or the
 * operator's init entry) re-execs the symlink — now the new binary. The previous
 * versioned binary is kept for rollback. Never touches the service, cert, or config.
 */
async function updateSelf(opts: {
    control: string; altControl: string | null; certPem: string; token: string; version: string;
    installDir: string | null; dataDir: string | null;
}): Promise<void> {
    console.log(`[update] self-update requested: ${AGENT_VERSION} -> ${opts.version}`);
    if (process.platform !== "linux") {
        throw new Error("Self-update is only supported on Linux");
    }
    // The installed service runs with --config, which carries the install/data dirs,
    // so this resolves to wherever installSelf put things.
    const paths = resolveInstallPaths(opts.installDir, opts.dataDir);
    console.log(`[update] install dir ${paths.dir}, data dir ${paths.dataDir}, symlink ${paths.bin}`);
    if (!(await isInstalled(AGENT_SPEC, paths))) {
        throw new Error("sc-agent is not installed as a service");
    }
    if (opts.version === AGENT_VERSION) {
        throw new Error(`Already running version ${AGENT_VERSION}`);
    }

    const bin = paths.versionedBin(opts.version);
    await downloadBinary({ control: opts.control, altControl: opts.altControl, certPem: opts.certPem, token: opts.token, dest: bin });
    console.log(`[update] repointing symlink ${paths.bin} -> ${bin}`);
    await pointSymlink(bin, paths.bin);
    await pruneOldBinaries(AGENT_SPEC, paths, bin);

    console.log(`[update] updated to ${opts.version}; exiting in 1.5s so the supervisor re-execs the new binary.`);
    // Exit so the supervisor re-execs the symlink → the new version. Delay so the
    // success reply is sent before we drop the connection.
    setTimeout(() => process.exit(0), 1500);
}

async function connect(url: string, id: Identity): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, {
            // @ts-expect-error Bun-specific TLS option
            // ca is the control-plane CA cert — our trust anchor. The server presents
            // a CA-signed leaf whose SAN covers the address we connect to (LAN IP, WAN
            // IP, or domain), so Bun's hostname↔SAN check passes by IP or by domain.
            // The leaf can be rotated/expanded server-side without touching agents,
            // since they only ever trust this CA.
            tls: { ca: id.certPem },
        });

        ws.onopen = () => {
            ws.send(JSON.stringify({
                type: "identify", token: id.token, info: id.info, machineId: id.machineId, mode: id.mode,
            } satisfies NodeMessage));
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(String(event.data));
                if (msg.type === "acknowledged") {
                    const standby = msg.active ? "" : " (standby — another agent is active for this machine)";
                    console.log(`Connected to control plane (machine ${msg.nodeId}, mode ${id.mode})${standby}`);
                    resolve(ws);
                }
            } catch { }
        };

        ws.onerror = (err) => reject(err);
        ws.onclose = () => reject(new Error("Connection closed before acknowledged"));
    });
}

async function runWithUrl(
    url: string,
    id: Identity,
    onInstallService: (agentToken: string, installDir: string | null, dataDir: string | null, mechanism: InstallMechanism) => Promise<{ startCommand: string | null }>,
    onUpdateService: (version: string) => Promise<void>,
): Promise<void> {
    const ws = await connect(url, id);
    const agent = new Agent(new WsTransport(ws), false, onInstallService, onUpdateService);
    agent.startMetrics();

    return new Promise((resolve) => {
        ws.onmessage = (event) => {
            try {
                void agent.onMessage(JSON.parse(String(event.data)));
            } catch { }
        };

        ws.onclose = () => { agent.stopMetrics(); resolve(); };
        ws.onerror = () => { agent.stopMetrics(); resolve(); };
    });
}

// ---- Entry -------------------------------------------------------------------

/** Run as a host agent (`server --agent …`), connecting to a control plane. */
export async function runAgentCli(argv: string[]): Promise<void> {
    const { control, altControl, token, cert, mode, installDir, dataDir } = await parseArgs(argv);
    const certPem = await Bun.file(cert).text();
    const info = await collectSystemInfo();
    const machineId = await resolveMachineId();
    const id: Identity = { token, machineId, mode, info, certPem };
    const urls = [control, ...(altControl ? [altControl] : [])];

    // The control URLs the installed service should reconnect with (and downloads
    // the updated binary from) are the same ones this live agent was given.
    const onInstallService = (agentToken: string, dir: string | null, data: string | null, mechanism: InstallMechanism) =>
        installSelf({ control, altControl, certPem, agentToken, installDir: dir, dataDir: data, mechanism });
    // installDir/dataDir come from the installed agent's config file (null for live).
    const onUpdateService = (version: string) => updateSelf({ control, altControl, certPem, token, version, installDir, dataDir });

    console.log(`sc-agent starting (mode ${mode}, machine ${machineId}), connecting to ${control}`);

    while (true) {
        let connected = false;
        for (const url of urls) {
            try {
                await runWithUrl(url, id, onInstallService, onUpdateService);
                connected = true;
                break;
            } catch (err) {
                console.warn(`Failed to connect to ${url}:`, (err as Error).message);
            }
        }

        if (!connected) {
            console.log(`All control plane URLs failed, retrying in ${RECONNECT_DELAY_MS / 1000}s…`);
        } else {
            console.log(`Disconnected, reconnecting in ${RECONNECT_DELAY_MS / 1000}s…`);
        }

        await Bun.sleep(RECONNECT_DELAY_MS);
        Object.assign(info, await collectSystemInfo());
    }
}
