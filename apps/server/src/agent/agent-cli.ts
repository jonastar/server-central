import * as fs from "node:fs/promises";
import type { AgentMode, InstallMechanism, NodeMessage, SystemInfo } from "@central/shared";
import { AGENT_CAPABILITIES, AGENT_VERSION } from "@central/shared";
import { Agent, type AgentTransport, collectSystemInfo, DEFAULT_DATA_DIR, DEFAULT_INSTALL_DIR, resolveMachineId } from "./agent";
import { sweepTempFilesIn, writeFileAtomic } from "../fs-atomic";
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
    run,
    writeManifest,
} from "./self-install";
import { readRuntimeState, runtimeStateDir, writeRuntimeState } from "./state";

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

/** Deadline for a single connect attempt, covering TCP + TLS + the WS upgrade +
 *  the control plane's `acknowledged`. Without it an attempt is bounded only by
 *  the OS: a black-holed host (dropped SYN — the normal shape of "the LAN
 *  address isn't reachable from here") takes ~127s of TCP SYN retries before
 *  failing over to the alt URL, and a peer that accepts the socket but never
 *  acknowledges hangs the loop *forever* — no alt attempt, no reconnect. Same
 *  hazard the self-update download already guards with DOWNLOAD_TIMEOUT_MS. */
const CONNECT_TIMEOUT_MS = 10_000;

/** How long the agent tolerates silence from a control plane that has beaten at
 *  least once. Must clear several missed beats (the control plane pings every
 *  15s) so a slow link doesn't cause reconnect churn. Overridable for tests and
 *  for links where that default is the wrong tradeoff. */
const HEARTBEAT_TIMEOUT_MS = Number(process.env.SC_AGENT_HEARTBEAT_TIMEOUT_MS) || 45_000;

/** Every Nth reconnect cycle, ignore the remembered endpoint and try the
 *  configured order instead, so an agent that fell back to the alt URL
 *  re-discovers the (usually LAN-local, cheaper) primary once it's reachable
 *  again. Only costs a probe on hosts that are already flapping. */
const PRIMARY_REPROBE_EVERY = 10;

interface Identity {
    token: string;
    machineId: string;
    mode: AgentMode;
    info: SystemInfo;
    certPem: string;
}

/** Callbacks the connect loop hands the Agent, plus the loop's own success hook. */
interface Handlers {
    onInstallService: (agentToken: string, installDir: string | null, dataDir: string | null, mechanism: InstallMechanism, force?: boolean) => Promise<{ startCommand: string | null }>;
    onUpdateService: (version: string, force?: boolean) => Promise<void>;
    /** Called with the URL that just reached the control plane and was acknowledged. */
    onConnected: (url: string) => void;
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
            const body = await res.arrayBuffer();
            // Written to a temp sibling and renamed into place (and removed again on
            // failure), so a partial download never leaves a corrupt binary the
            // symlink could point at.
            await writeFileAtomic(opts.dest, body, { mode: 0o755 });
            console.log(`[update] downloaded ${body.byteLength} bytes from ${url} in ${Date.now() - startedAt}ms`);
            return;
        } catch (err) {
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
 * — and exit so the installed agent takes over. Errors out if already installed,
 * unless `force` is set, in which case the existing config/cert/binaries are
 * overwritten in place — for repairing a broken or partial prior install.
 */
async function installSelf(opts: {
    control: string; altControl: string | null; certPem: string; agentToken: string;
    installDir: string | null; dataDir: string | null; mechanism: InstallMechanism; force?: boolean;
}): Promise<{ startCommand: string | null }> {
    if (process.platform !== "linux") {
        throw new Error("Service install is only supported on Linux");
    }
    const paths = resolveInstallPaths(opts.installDir, opts.dataDir);
    const alreadyInstalled = await isInstalled(AGENT_SPEC, paths);
    if (alreadyInstalled && !opts.force) {
        throw new Error("sc-agent service is already installed");
    }
    if (alreadyInstalled) {
        console.log("[install] force: overwriting existing install (config, cert, binaries)");
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
        if (alreadyInstalled) {
            // enable --now leaves an already-active unit running untouched, so
            // restart explicitly — otherwise the overwritten binary/config never load.
            await run("systemctl", ["restart", AGENT_SPEC.name]);
        }
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
    control: string; altControl: string | null; certPem: string; token: string; version: string; force?: boolean;
    installDir: string | null; dataDir: string | null;
}): Promise<void> {
    console.log(`[update] self-update requested: ${AGENT_VERSION} -> ${opts.version}${opts.force ? " (forced)" : ""}`);
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
    if (opts.version === AGENT_VERSION && !opts.force) {
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

/** Drop a socket now, without waiting for a close handshake the peer may never
 *  answer — the whole point when we've decided the link is dead. */
function hangUp(ws: WebSocket): void {
    try {
        // Bun exposes ws-style terminate(); close() alone can wait on a peer that
        // will never reply, which on a half-open TCP means minutes of nothing.
        const terminate = (ws as WebSocket & { terminate?: () => void }).terminate;
        if (typeof terminate === "function") {
            terminate.call(ws);
        } else {
            ws.close();
        }
    } catch { /* already gone */ }
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

        // One-shot settle: the handlers below stay installed until runWithUrl
        // replaces them, and the deadline fires independently of both.
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            hangUp(ws);
            reject(new Error(`timed out after ${CONNECT_TIMEOUT_MS / 1000}s (no acknowledgement)`));
        }, CONNECT_TIMEOUT_MS);
        const settle = (done: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            done();
        };

        ws.onopen = () => {
            ws.send(JSON.stringify({
                type: "identify", token: id.token, info: id.info, machineId: id.machineId, mode: id.mode,
                capabilities: [...AGENT_CAPABILITIES],
            } satisfies NodeMessage));
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(String(event.data));
                if (msg.type === "acknowledged") {
                    const standby = msg.active ? "" : " (standby — another agent is active for this machine)";
                    settle(() => {
                        console.log(`Connected to control plane at ${url} (machine ${msg.nodeId}, mode ${id.mode})${standby}`);
                        resolve(ws);
                    });
                }
            } catch { }
        };

        ws.onerror = (err) => settle(() => reject(err));
        ws.onclose = () => settle(() => reject(new Error("Connection closed before acknowledged")));
    });
}

async function runWithUrl(url: string, id: Identity, handlers: Handlers): Promise<void> {
    const ws = await connect(url, id);
    handlers.onConnected(url);
    const agent = new Agent(new WsTransport(ws), false, handlers.onInstallService, handlers.onUpdateService);
    agent.startMetrics();

    return new Promise((resolve) => {
        // Armed by the first `ping` and refreshed by every message after it, so a
        // control plane too old to beat (or one that stops beating mid-connection)
        // keeps the pre-heartbeat behaviour instead of reconnect-looping.
        let watchdog: ReturnType<typeof setTimeout> | null = null;
        let done = false;
        const finish = (why: string | null) => {
            if (done) {
                return;
            }
            done = true;
            if (watchdog) {
                clearTimeout(watchdog);
            }
            agent.stopMetrics();
            if (why) {
                console.warn(why);
            }
            resolve();
        };
        const armWatchdog = () => {
            if (watchdog) {
                clearTimeout(watchdog);
            }
            watchdog = setTimeout(() => {
                // Don't wait for onclose: a half-open socket may never produce one
                // (our close frame goes into a void), which is exactly the state
                // we're trying to escape. Hang up and drive the reconnect here.
                hangUp(ws);
                finish(`No heartbeat from the control plane in ${HEARTBEAT_TIMEOUT_MS / 1000}s; treating the connection as dead.`);
            }, HEARTBEAT_TIMEOUT_MS);
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(String(event.data));
                if (msg.type === "ping" || watchdog) {
                    armWatchdog();
                }
                void agent.onMessage(msg);
            } catch { }
        };

        ws.onclose = () => finish(null);
        ws.onerror = () => finish(null);
    });
}

// ---- Entry -------------------------------------------------------------------

/** Put the remembered endpoint first, keeping the configured order behind it.
 *  Ignores a remembered URL that's no longer configured (the operator moved the
 *  control plane), so state can never strand an agent on a dead address. */
function orderUrls(urls: string[], preferred: string | null): string[] {
    if (!preferred || urls[0] === preferred || !urls.includes(preferred)) {
        return urls;
    }
    return [preferred, ...urls.filter((u) => u !== preferred)];
}

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
    const onInstallService = (agentToken: string, dir: string | null, data: string | null, mechanism: InstallMechanism, force?: boolean) =>
        installSelf({ control, altControl, certPem, agentToken, installDir: dir, dataDir: data, mechanism, force });
    // installDir/dataDir come from the installed agent's config file (null for live).
    const onUpdateService = (version: string, force?: boolean) => updateSelf({ control, altControl, certPem, token, version, force, installDir, dataDir });

    // Which URL worked last time, remembered across restarts. A host that only
    // reaches the control plane via the alt endpoint (typically off-LAN, where
    // the primary is a LAN address) would otherwise burn a full connect timeout
    // on the primary before every single reconnect.
    let preferred = (await readRuntimeState(dataDir)).lastControl ?? null;
    const onConnected = (url: string) => {
        if (url === preferred) {
            return;
        }
        preferred = url;
        void writeRuntimeState(dataDir, { lastControl: url, lastControlAt: Date.now() });
    };
    const handlers: Handlers = { onInstallService, onUpdateService, onConnected };

    // Clear debris from a previous run killed mid-write: a partial self-update
    // download or symlink swap under the install dir, an interrupted state write
    // under the data dir. Nothing here is in use at startup, and an unclean kill
    // (systemd stop during an update, power loss) is exactly when it's left behind.
    await sweepTempFilesIn([installDir, runtimeStateDir(dataDir)], "agent");

    console.log(`sc-agent starting (mode ${mode}, machine ${machineId}), connecting to ${preferred ?? control}`);

    for (let cycle = 0; ; cycle++) {
        const reprobe = cycle > 0 && cycle % PRIMARY_REPROBE_EVERY === 0;
        let connected = false;
        for (const url of orderUrls(urls, reprobe ? null : preferred)) {
            try {
                await runWithUrl(url, id, handlers);
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
