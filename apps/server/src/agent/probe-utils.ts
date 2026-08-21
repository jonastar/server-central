import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Shared primitives for feature host probes (see `AgentFeature.hostProbe`).
 *
 * Deliberately filesystem-level rather than shell-level: probes answer "is this
 * usable here", and `sh -c` can cheaply answer only "is the binary on PATH".
 */

/** Resolve an executable on PATH, the way execvp would. Null when not found. */
export async function which(bin: string): Promise<string | null> {
    const dirs = (process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin").split(path.delimiter);
    for (const dir of dirs) {
        if (!dir) {
            continue;
        }
        const candidate = path.join(dir, bin);
        try {
            await fs.access(candidate, fs.constants.X_OK);
            return candidate;
        } catch { /* next */ }
    }
    return null;
}

export async function exists(target: string): Promise<boolean> {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}

/** `mode` is an fs.constants bitmask (R_OK / W_OK / X_OK). */
export async function accessible(target: string, mode: number): Promise<boolean> {
    try {
        await fs.access(target, mode);
        return true;
    } catch {
        return false;
    }
}

export { constants } from "node:fs";
