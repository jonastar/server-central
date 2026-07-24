import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fallbackStateDir } from "./machine-id";

/**
 * Runtime state the agent writes about itself, kept deliberately separate from
 * `config.json`:
 *
 * - config.json is *input* — operator/installer-authored launch parameters. It's
 *   rewritten wholesale by installSelf (including force-reinstall), so anything
 *   the connect loop wrote there would be clobbered, and a concurrent install
 *   would race the connect loop's read-modify-write.
 * - state.json is *output* — derived, disposable, and safe to delete. Losing it
 *   costs one slower reconnect, nothing else.
 *
 * Every field is optional and unknown fields are preserved on write, so this can
 * grow without a migration.
 */
export interface AgentRuntimeState {
    /** Control URL that last reached the control plane; tried first on reconnect. */
    lastControl?: string;
    /** When lastControl succeeded (ms epoch) — diagnostics only. */
    lastControlAt?: number;
    [key: string]: unknown;
}

/** State file location: the install data dir for an installed agent (alongside
 *  its cert/config), else the live agent's fallback state dir. */
export function stateFilePath(dataDir: string | null): string {
    return path.join(dataDir ?? fallbackStateDir(), "state.json");
}

/** Read persisted state. A missing or corrupt file is simply empty state — this
 *  is a cache, never a source of truth, so it must not block startup. */
export async function readRuntimeState(dataDir: string | null): Promise<AgentRuntimeState> {
    try {
        const parsed = JSON.parse(await Bun.file(stateFilePath(dataDir)).text()) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as AgentRuntimeState;
        }
    } catch { /* no state yet, or unreadable — start empty */ }
    return {};
}

/**
 * Merge `patch` into the persisted state and write it atomically (temp file +
 * rename), so a crash mid-write can't leave a truncated file. Best-effort: a
 * read-only or full data dir must never take the agent down, so failures are
 * logged and swallowed.
 */
export async function writeRuntimeState(dataDir: string | null, patch: AgentRuntimeState): Promise<void> {
    const file = stateFilePath(dataDir);
    try {
        const merged = { ...(await readRuntimeState(dataDir)), ...patch };
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        await Bun.write(tmp, JSON.stringify(merged, null, 2));
        await fs.rename(tmp, file);
    } catch (err) {
        console.warn(`Could not persist agent state to ${file}: ${(err as Error)?.message ?? err}`);
    }
}
