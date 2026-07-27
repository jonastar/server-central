import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

// Atomic file replacement, and cleanup of the temp files it leaves behind when a
// process dies mid-write. Every durable write in the control plane and the agent
// goes through here so there's exactly one temp-file naming scheme to sweep.

/** Temp sibling of `file`: same directory (so rename(2) stays within one
 *  filesystem and therefore atomic), pid + random suffix so concurrent writers
 *  and concurrent processes never collide. */
export function tempSibling(file: string): string {
    return `${file}.sc-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
}

/**
 * Names this sweeper recognizes as abandoned temp files. Covers the current
 * scheme plus the three ad-hoc shapes that predate it (`<hex>.tmp` from
 * writeFileAtomic, `.tmp-<pid>` from symlink swaps and agent state, and
 * `.download-<pid>` from binary downloads), since orphans of those are still on
 * disk in the wild.
 */
const TEMP_FILE_RE = /\.(?:sc-tmp-\d+-[0-9a-f]+|[0-9a-f]+\.tmp|tmp-\d+|download-\d+)$/;

/** Grace period before a temp file counts as abandoned. Generous enough that a
 *  concurrently running instance's in-flight write (milliseconds) is never
 *  touched, short enough that debris doesn't outlive a restart. */
const SWEEP_MIN_AGE_MS = 5 * 60 * 1000;

/**
 * Write a file atomically: write to a temp sibling, then rename over the target.
 * rename(2) is atomic within a filesystem, so a crash mid-write leaves the old
 * file intact rather than a truncated one — important for the user/session/token
 * stores, where a corrupt file would lock everyone out or orphan every agent.
 *
 * On failure the temp file is removed before rethrowing; only an unclean kill
 * between write and rename can leave one behind, which is what sweepTempFiles
 * mops up at startup.
 */
export async function writeFileAtomic(
    file: string,
    content: string | NodeJS.TypedArray | ArrayBuffer,
    opts: { mode?: number } = {},
): Promise<void> {
    const tmp = tempSibling(file);
    try {
        await Bun.write(tmp, content as string);
        if (opts.mode !== undefined) {
            await fs.chmod(tmp, opts.mode);
        }
        await fs.rename(tmp, file);
    } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => { });
        throw err;
    }
}

/**
 * Delete abandoned temp files directly under `dir`. Best-effort and never throws:
 * a missing directory, a permission error, or a file that vanished mid-sweep all
 * just mean less was cleaned. Returns how many were removed.
 *
 * Age-gated rather than unconditional so a second instance sharing the directory
 * can't have an in-flight write deleted out from under it.
 */
export async function sweepTempFiles(dir: string, minAgeMs = SWEEP_MIN_AGE_MS): Promise<number> {
    let removed = 0;
    let entries: string[];
    try {
        entries = await fs.readdir(dir);
    } catch {
        return 0;
    }
    const cutoff = Date.now() - minAgeMs;
    for (const name of entries) {
        if (!TEMP_FILE_RE.test(name)) {
            continue;
        }
        const full = path.join(dir, name);
        try {
            // lstat, not stat: an abandoned symlink swap points at a target that
            // may not exist, and stat would follow it and throw.
            const st = await fs.lstat(full);
            if (st.mtimeMs < cutoff) {
                await fs.rm(full, { force: true });
                removed++;
            }
        } catch { /* raced with another sweeper, or not ours to remove */ }
    }
    return removed;
}

/** Sweep several directories and log once if anything was actually cleaned. */
export async function sweepTempFilesIn(dirs: Array<string | null | undefined>, label: string): Promise<void> {
    const counts = await Promise.all(dirs.filter((d): d is string => !!d).map((d) => sweepTempFiles(d)));
    const total = counts.reduce((a, b) => a + b, 0);
    if (total > 0) {
        console.log(`[${label}] removed ${total} abandoned temp file(s)`);
    }
}
