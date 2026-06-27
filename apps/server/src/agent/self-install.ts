import * as fs from "node:fs/promises";
import { probeDir } from "./mounts";

// Role-agnostic self-install primitives shared by the host agent and the control
// plane. Both install the same way: copy the running binary to a versioned path
// under the install dir, point a stable symlink at it (what the supervisor execs),
// and supervise via systemd Restart=always so a self-update is just "swap symlink +
// exit". The role-specific bits (service name, ExecStart, env, any extra files) live
// in the caller; this module owns the layout, symlink swap, pruning, and unit write.

/** How many versioned binaries to keep (current + this many for rollback). */
export const KEEP_VERSIONS = 2;

/** Identifies one installable role: its systemd unit + versioned-binary base name. */
export interface ServiceSpec {
    /** systemd unit + symlink + versioned-binary base name, e.g. "sc-agent" / "sc-central". */
    name: string;
    description: string;
}

export interface InstallPaths {
    /** Dir holding versioned binaries + the stable symlink. */
    dir: string;
    /** Stable symlink the service execs; repointed at a versioned binary on update. */
    bin: string;
    /** Writable, exec-capable dir for state/scratch. */
    dataDir: string;
    /** Records which persistence mechanism was used, so update + "already installed?"
     *  work regardless of where (or whether) a unit lives. */
    manifest: string;
    /** Exec-capable scratch (Bun extracts its native addons here, via TMPDIR). */
    tmpDir: string;
    versionedBin(version: string): string;
}

export interface InstallManifest {
    mechanism: "systemd" | "manual";
}

/** The systemd unit path for a role. */
export function unitPath(spec: ServiceSpec): string {
    return `/etc/systemd/system/${spec.name}.service`;
}

/** Resolve the install layout for a role under the given (or default) dirs. */
export function resolveServicePaths(
    spec: ServiceSpec,
    installDir: string,
    dataDir: string,
): InstallPaths {
    return {
        dir: installDir,
        bin: `${installDir}/${spec.name}`,
        dataDir,
        manifest: `${dataDir}/install.json`,
        tmpDir: `${dataDir}/tmp`,
        versionedBin: (version) => `${installDir}/${spec.name}-${version}`,
    };
}

export async function run(cmd: string, args: string[]): Promise<void> {
    const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
        const err = (await new Response(proc.stderr).text()).trim();
        throw new Error(`${cmd} ${args.join(" ")} failed (exit ${code})${err ? `: ${err}` : ""}`);
    }
}

/** Atomically point `link` at `target` (replacing any existing file/symlink). */
export async function pointSymlink(target: string, link: string): Promise<void> {
    const tmp = `${link}.tmp-${process.pid}`;
    await fs.symlink(target, tmp);
    await fs.rename(tmp, link); // rename over an existing path is atomic on Linux
}

/**
 * Drop all but the newest KEEP_VERSIONS `<name>-<version>` binaries so rollback stays
 * possible without unbounded disk use. Never removes `keep` (the version just
 * installed, which the symlink now points at). The bare `<name>` symlink doesn't
 * match the `<name>-` prefix, so it's untouched.
 */
export async function pruneOldBinaries(spec: ServiceSpec, paths: InstallPaths, keep: string): Promise<void> {
    const prefix = `${spec.name}-`;
    const entries = await fs.readdir(paths.dir);
    const versioned = await Promise.all(
        entries
            .filter((n) => n.startsWith(prefix))
            .map(async (n) => {
                const full = `${paths.dir}/${n}`;
                const st = await fs.stat(full).catch(() => null);
                return st ? { full, mtime: st.mtimeMs } : null;
            }),
    );
    const sorted = versioned
        .filter((e): e is { full: string; mtime: number } => e !== null)
        .sort((a, b) => b.mtime - a.mtime);
    for (const { full } of sorted.slice(KEEP_VERSIONS)) {
        if (full === keep) {
            continue;
        }
        await fs.rm(full, { force: true }).catch(() => { });
    }
}

/** Preflight install + data dirs: each must be writable and exec-capable, with an
 *  actionable error so an appliance OS (read-only root / noexec mount) tells the
 *  operator to choose pool paths. */
export async function ensureInstallPathsUsable(paths: InstallPaths): Promise<void> {
    for (const dir of [paths.dir, paths.dataDir]) {
        const probe = await probeDir(dir);
        if (!probe.writable || !probe.execCapable) {
            const why = !probe.writable ? "not writable" : "mounted noexec";
            throw new Error(
                `Install path "${dir}" is ${why}. Choose install and data directories on `
                + `writable, exec-capable storage (e.g. a storage pool like /mnt/pool).`,
            );
        }
    }
}

export async function writeManifest(paths: InstallPaths, m: InstallManifest): Promise<void> {
    await fs.writeFile(paths.manifest, JSON.stringify(m));
}

export async function readManifest(paths: InstallPaths): Promise<InstallManifest | null> {
    try {
        return JSON.parse(await Bun.file(paths.manifest).text()) as InstallManifest;
    } catch {
        return null;
    }
}

/** Whether the role is already installed, by either persistence mechanism. */
export async function isInstalled(spec: ServiceSpec, paths: InstallPaths): Promise<boolean> {
    return (await Bun.file(unitPath(spec)).exists()) || (await readManifest(paths)) !== null;
}

/** Copy the running binary to its versioned path under the install dir, executable. */
export async function copySelfToVersionedBin(paths: InstallPaths, version: string): Promise<string> {
    const bin = paths.versionedBin(version);
    await fs.copyFile(process.execPath, bin);
    await fs.chmod(bin, 0o755);
    return bin;
}

/**
 * Install a systemd unit for the role at unitPath(spec). Restart=always gives crash
 * recovery and re-execs the symlink after a self-update. `execStart` should invoke
 * paths.bin; `env` lines (e.g. TMPDIR, SC_DATA_DIR) are added to the unit.
 */
export async function installSystemd(
    spec: ServiceSpec,
    paths: InstallPaths,
    opts: { execStart: string; env: Record<string, string> },
): Promise<void> {
    const envLines = Object.entries(opts.env)
        .map(([k, v]) => `Environment=${k}=${v}`)
        .join("\n");
    const unit = `[Unit]
Description=${spec.description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${envLines}
ExecStart=${opts.execStart}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
    await fs.writeFile(unitPath(spec), unit);
    await run("systemctl", ["daemon-reload"]);
    await run("systemctl", ["enable", "--now", spec.name]);
}
