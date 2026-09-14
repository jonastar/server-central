import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { InstallMechanism, TaskUpdateControlPlaneResult } from "@central/shared";
import { AGENT_VERSION } from "@central/shared";
import { DEFAULT_INSTALL_DIR } from "./agent/agent";
import { downloadVerifiedBinary, getLatestVersion } from "./binary-store";
import { CONFIG_DIR, takePendingUpdate, writePendingUpdate } from "./config";
import type { OrphanResolver } from "./tasks/store";
import type { TaskCtx } from "./tasks/types";
import {
    type ServiceSpec,
    copySelfToVersionedBin,
    ensureInstallPathsUsable,
    installSystemd,
    isInstalled,
    pointSymlink,
    pruneOldBinaries,
    readManifest,
    resolveServicePaths,
    unitPath,
    writeManifest,
} from "./agent/self-install";

// Self-install for the control plane. The single binary installs itself as a
// supervised system service exactly like a host agent does (versioned binary +
// stable symlink + systemd Restart=always), reusing the shared self-install
// primitives — just a different service name, data dir, and ExecStart. The control
// plane keeps all state under its data dir via SC_DATA_DIR, so the installed unit is
// self-contained regardless of the working directory.

/** The control-plane role: systemd unit + symlink + versioned-binary base name. */
const SERVER_SPEC: ServiceSpec = { name: "sc-central", description: "Server Central control plane" };
export const DEFAULT_SERVER_DATA_DIR = "/var/lib/sc-central";

function resolveServerPaths(installDir: string | null, dataDir: string | null) {
    return resolveServicePaths(SERVER_SPEC, installDir || DEFAULT_INSTALL_DIR, dataDir || DEFAULT_SERVER_DATA_DIR);
}

/** Whether the control plane is already installed as a service. */
export function isServerInstalled(installDir: string | null = null, dataDir: string | null = null): Promise<boolean> {
    return isInstalled(SERVER_SPEC, resolveServerPaths(installDir, dataDir));
}

/**
 * Install the control plane as a service: copy the running binary to a versioned
 * path, point the stable symlink at it, and supervise it (systemd, or "manual" which
 * lays down files and returns a start command). The installed instance reads/writes
 * its state under SC_DATA_DIR=<dataDir>. Returns a start command for the manual
 * mechanism (null for systemd). Caller should exit afterward so the service owns the
 * ports.
 */
export async function installControlPlane(opts: {
    installDir: string | null;
    dataDir: string | null;
    mechanism: InstallMechanism;
}): Promise<{ startCommand: string | null }> {
    if (process.platform !== "linux") {
        throw new Error("Control-plane service install is only supported on Linux");
    }
    const paths = resolveServerPaths(opts.installDir, opts.dataDir);
    if (await isInstalled(SERVER_SPEC, paths)) {
        throw new Error("Server Central control plane is already installed");
    }

    await ensureInstallPathsUsable(paths);
    await fs.mkdir(paths.tmpDir, { recursive: true });

    const bin = await copySelfToVersionedBin(paths, AGENT_VERSION);
    await pointSymlink(bin, paths.bin);

    // SC_DATA_DIR makes the binary resolve CONFIG_DIR (config, TLS, tokens, the
    // agent-binary cache) under the data dir; TMPDIR keeps Bun's addon extraction on
    // exec-capable storage. No --agent flag → it boots the control plane.
    const env = { TMPDIR: paths.tmpDir, SC_DATA_DIR: paths.dataDir };

    let startCommand: string | null = null;
    if (opts.mechanism === "systemd") {
        await installSystemd(SERVER_SPEC, paths, { execStart: paths.bin, env });
        console.log(`Installed Server Central as a systemd service (${SERVER_SPEC.name}). It is now running.`);
    } else {
        startCommand = `SC_DATA_DIR=${paths.dataDir} TMPDIR=${paths.tmpDir} ${paths.bin}`;
        try {
            Bun.spawn(["/bin/sh", "-c", `setsid ${startCommand} >/dev/null 2>&1 &`], { stdout: "ignore", stderr: "ignore" });
        } catch { /* operator runs startCommand manually */ }
        console.log("Installed Server Central (manual); started detached and returned a start command.");
    }
    await writeManifest(paths, { mechanism: opts.mechanism });
    console.log(`Binary: ${paths.bin}  Data dir: ${paths.dataDir}  Web UI + API on :4141`);
    return { startCommand };
}

interface ServerInstallArgs {
    installDir: string | null;
    dataDir: string | null;
    mechanism: InstallMechanism;
}

function parseServerInstallArgs(argv: string[]): ServerInstallArgs {
    let installDir: string | null = null;
    let dataDir: string | null = null;
    let mechanism: InstallMechanism = "systemd";
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--install-dir") {
            installDir = argv[++i] ?? null;
        } else if (argv[i] === "--data-dir") {
            dataDir = argv[++i] ?? null;
        } else if (argv[i] === "--mechanism") {
            const value = argv[++i];
            if (value !== "systemd" && value !== "manual") {
                console.error(`--mechanism must be "systemd" or "manual"`);
                process.exit(1);
            }
            mechanism = value;
        }
    }
    return { installDir, dataDir, mechanism };
}

/** Non-interactive install entry: `sc-central --install-server [--install-dir …]
 *  [--data-dir …] [--mechanism systemd|manual]`. Sensible defaults fill the rest. */
export async function runServerInstallCli(argv: string[]): Promise<void> {
    const args = parseServerInstallArgs(argv);
    try {
        const { startCommand } = await installControlPlane(args);
        if (startCommand) {
            console.log(`\nStart command (wire into your init system):\n  ${startCommand}`);
        }
    } catch (err) {
        console.error(`Install failed: ${(err as Error).message}`);
        process.exit(1);
    }
}

/**
 * Interactive first-run: when the bare binary is run on a TTY and isn't installed,
 * offer to install as a service with sensible defaults. Returns true if it installed
 * (caller should exit), false to fall through and run in the foreground.
 */
export async function offerInteractiveInstall(): Promise<boolean> {
    if (process.platform !== "linux" || await isServerInstalled()) {
        return false;
    }
    const yes = prompt("Install Server Central as a system service? [Y/n]", "Y");
    if (yes === null || !/^y(es)?$/i.test(yes.trim() || "y")) {
        console.log("Skipping install; running in the foreground (Ctrl-C to stop).");
        return false;
    }
    const installDir = prompt("Install dir (binary)", DEFAULT_INSTALL_DIR) || DEFAULT_INSTALL_DIR;
    const dataDir = prompt("Data dir (state)", DEFAULT_SERVER_DATA_DIR) || DEFAULT_SERVER_DATA_DIR;
    try {
        await installControlPlane({ installDir, dataDir, mechanism: "systemd" });
        return true;
    } catch (err) {
        console.error(`Install failed: ${(err as Error).message}`);
        console.log("Falling back to running in the foreground.");
        return false;
    }
}

export interface ControlPlaneStatus {
    version: string;
    installed: boolean;
    /** Latest available version, or null when the release source can't be reached. */
    latestVersion: string | null;
    updateAvailable: boolean;
    /** systemd unit the control plane's own output goes to, so the UI can offer
     *  its journal. Null when there is no unit to read — a manual install or a
     *  dev run logs to whatever started it, and journalctl has nothing for it. */
    logUnit: string | null;
}

/** The unit journald would have output for. The unit *file*, not the install
 *  manifest: a manual install is "installed" too, and journald knows nothing
 *  about it. Null means there is simply no journal to read. */
async function serverLogUnit(): Promise<string | null> {
    return await Bun.file(unitPath(SERVER_SPEC)).exists() ? `${SERVER_SPEC.name}.service` : null;
}

/**
 * How the control plane's own install is laid out, for the embedded agent's
 * config panel — the one agent whose "config" is the control plane's, since it
 * runs in that process rather than dialing it.
 *
 * `dataDir` is {@link CONFIG_DIR}, the directory this process actually reads and
 * writes, rather than the install default: `SC_DATA_DIR` can point anywhere, and
 * the panel exists to show what's true of the running instance.
 */
export async function controlPlaneInstallInfo(): Promise<{
    installDir: string | null;
    dataDir: string;
    mechanism: InstallMechanism | null;
    logUnit: string | null;
}> {
    const paths = resolveServerPaths(null, CONFIG_DIR);
    const manifest = await readManifest(paths);
    return {
        // Only meaningful once there's an install to describe; a `bun dev` run
        // has a binary path, but not one anybody installed.
        installDir: manifest ? paths.dir : null,
        dataDir: CONFIG_DIR,
        mechanism: manifest?.mechanism ?? null,
        logUnit: await serverLogUnit(),
    };
}

/** Current vs. latest version for the control plane, for the UI's update affordance.
 *  A failed release-source check degrades to latestVersion=null (no update offered)
 *  rather than erroring. */
export async function controlPlaneStatus(): Promise<ControlPlaneStatus> {
    const installed = await isServerInstalled();
    let latestVersion: string | null = null;
    try {
        latestVersion = await getLatestVersion();
    } catch (err) {
        console.warn(`[update] latest-release check failed: ${(err as Error).message}`);
    }
    return {
        version: AGENT_VERSION,
        installed,
        latestVersion,
        updateAvailable: installed && latestVersion !== null && latestVersion !== AGENT_VERSION,
        logUnit: await serverLogUnit(),
    };
}

/** Grace between the last log line and `process.exit`, so the `taskLog`
 *  broadcasts and the persisted run state are on the wire / on disk first. */
const EXIT_DELAY_MS = 1500;

/**
 * Self-update the installed control plane, as the body of the
 * `update_control_plane` task: fetch its own-platform binary for the latest
 * release (checksum-verified), point the stable symlink at it, leave a note for
 * the next process (`writePendingUpdate`), then exit so the supervisor (systemd
 * Restart=always) re-execs the new version. Mirrors the host agent's self-update;
 * the install dir is the dir the running binary lives in, the data dir is the
 * active CONFIG_DIR (SC_DATA_DIR).
 *
 * On the success path this never resolves: the process is gone before it could.
 * The run stays `running` on disk and the new process settles it on boot via
 * {@link interruptedUpdateResolver} — that's what makes the run's completion
 * mean "the new version is up", not merely "the old one agreed to go". Every
 * failure path throws normally, before anything irreversible.
 */
export async function updateControlPlane(ctx: Pick<TaskCtx, "id" | "log">): Promise<TaskUpdateControlPlaneResult> {
    if (process.platform !== "linux") {
        throw new Error("Control-plane self-update is only supported on Linux");
    }
    const installDir = path.dirname(process.execPath);
    const paths = resolveServerPaths(installDir, CONFIG_DIR);
    if (!(await isInstalled(SERVER_SPEC, paths))) {
        throw new Error("Control plane is not installed as a service");
    }
    const latest = await getLatestVersion();
    if (latest === AGENT_VERSION) {
        throw new Error(`Already on the latest version (${AGENT_VERSION})`);
    }

    // Guarded to linux above; the control plane only runs there.
    const platform = `linux-${process.arch}`;
    const bin = paths.versionedBin(latest);
    console.log(`[update] control-plane self-update ${AGENT_VERSION} -> ${latest} (${platform})`);
    ctx.log(`Updating ${AGENT_VERSION} -> ${latest} (${platform})`);
    ctx.log(`Downloading ${latest}...`);
    await downloadVerifiedBinary(platform, latest, bin);
    ctx.log(`Downloaded and verified ${bin}`);
    // The marker goes down before the symlink moves: if writing it fails the
    // run fails with nothing changed, whereas a symlink already repointed with
    // no marker would restart into a run nobody can settle.
    await writePendingUpdate({ runId: ctx.id, version: latest });
    await pointSymlink(bin, paths.bin);
    await pruneOldBinaries(SERVER_SPEC, paths, bin);
    ctx.log(`Installed ${latest} as ${paths.bin}`);
    ctx.log("Restarting the control plane — this run completes once the new version is up.");

    console.log(`[update] updated to ${latest}; exiting in ${EXIT_DELAY_MS}ms so the supervisor re-execs the new binary.`);
    setTimeout(() => process.exit(0), EXIT_DELAY_MS);
    return new Promise<never>(() => { /* the process exits first */ });
}

/**
 * How the *new* process settles the `update_control_plane` run the old one left
 * `running`: succeeded if this is the version that run installed, failed
 * (saying which version came up instead) if not. Taken once at boot — the
 * marker is consumed whether or not the run it names is still in the store —
 * and any other orphaned run of this kind gets the store's generic
 * "interrupted" verdict, since nothing vouches for it.
 */
export async function interruptedUpdateResolver(): Promise<OrphanResolver> {
    const pending = await takePendingUpdate();
    if (pending) {
        console.log(`[update] booted after self-update to ${pending.version} (running ${AGENT_VERSION}); settling run ${pending.runId}`);
    }
    return (run) => {
        if (run.spec.kind !== "update_control_plane" || !pending || run.id !== pending.runId) {
            return null;
        }
        if (pending.version !== AGENT_VERSION) {
            return { status: "failed", error: `Restarted on ${AGENT_VERSION}, expected ${pending.version}` };
        }
        return { status: "succeeded", result: { kind: "update_control_plane", version: AGENT_VERSION } };
    };
}
