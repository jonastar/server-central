import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { InstallProbeResult } from "@central/shared";

/**
 * Whether the filesystem backing `target` is mounted with `flag` (e.g. "ro",
 * "noexec"), per /proc/mounts — the longest matching mountpoint wins. Returns
 * false if /proc/mounts can't be read (non-Linux, sandboxed, etc.).
 */
export async function mountHasFlag(target: string, flag: string): Promise<boolean> {
    try {
        const mounts = await fs.readFile("/proc/mounts", "utf8");
        let opts: string | null = null;
        let bestLen = -1;
        for (const line of mounts.split("\n")) {
            const parts = line.split(" ");
            const mnt = parts[1];
            if (!mnt) {
                continue;
            }
            const prefix = mnt.endsWith("/") ? mnt : `${mnt}/`;
            if ((target === mnt || target.startsWith(prefix)) && mnt.length > bestLen) {
                opts = parts[3] ?? "";
                bestLen = mnt.length;
            }
        }
        return opts !== null && opts.split(",").includes(flag);
    } catch {
        return false;
    }
}

/** Can a binary actually be executed from `dir`? Writes a tiny script, makes it
 *  executable, and runs it — catching noexec mounts directly rather than guessing
 *  from /proc/mounts. The probe file is always removed. */
async function dirIsExecCapable(dir: string): Promise<boolean> {
    const script = path.join(dir, `.sc-agent-exec-${process.pid}.sh`);
    try {
        await fs.writeFile(script, "#!/bin/sh\nexit 0\n");
        await fs.chmod(script, 0o755);
        const proc = Bun.spawn([script], { stdout: "ignore", stderr: "ignore" });
        return (await proc.exited) === 0;
    } catch {
        return false;
    } finally {
        await fs.rm(script, { force: true }).catch(() => {});
    }
}

/**
 * Probe a candidate install/data directory: whether it already exists, is writable
 * (creating it if missing), and can execute a binary (not a noexec mount). Used by
 * the setup wizard and the install preflight so unusable appliance paths are caught
 * before anything is written.
 */
export async function probeDir(dir: string): Promise<InstallProbeResult> {
    const exists = await fs.stat(dir).then((s) => s.isDirectory()).catch(() => false);
    let writable = false;
    let execCapable = false;
    try {
        await fs.mkdir(dir, { recursive: true });
        const probe = path.join(dir, `.sc-agent-write-${process.pid}`);
        await fs.writeFile(probe, "");
        await fs.rm(probe, { force: true });
        writable = true;
        execCapable = await dirIsExecCapable(dir);
    } catch { /* leave writable/execCapable false */ }
    return { exists, writable, execCapable };
}
