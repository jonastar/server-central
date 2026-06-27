import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { InstallMechanism } from "@central/shared";
import { AGENT_VERSION } from "@central/shared";
import { DEFAULT_INSTALL_DIR } from "./agent/agent";
import { downloadVerifiedBinary, getLatestVersion } from "./binary-store";
import { CONFIG_DIR } from "./config";
import {
    type ServiceSpec,
    copySelfToVersionedBin,
    ensureInstallPathsUsable,
    installSystemd,
    isInstalled,
    pointSymlink,
    pruneOldBinaries,
    resolveServicePaths,
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
const DEFAULT_SERVER_DATA_DIR = "/var/lib/sc-central";

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
    };
}

/**
 * Self-update the installed control plane: fetch its own-platform binary for the
 * latest release (checksum-verified), point the stable symlink at it, then exit so
 * the supervisor (systemd Restart=always) re-execs the new version. Mirrors the host
 * agent's self-update; the install dir is the dir the running binary lives in, the
 * data dir is the active CONFIG_DIR (SC_DATA_DIR).
 */
export async function updateControlPlane(): Promise<void> {
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
    await downloadVerifiedBinary(platform, latest, bin);
    await pointSymlink(bin, paths.bin);
    await pruneOldBinaries(SERVER_SPEC, paths, bin);

    console.log(`[update] updated to ${latest}; exiting in 1.5s so the supervisor re-execs the new binary.`);
    // Delay so the API success reply is sent before we drop the connection.
    setTimeout(() => process.exit(0), 1500);
}
