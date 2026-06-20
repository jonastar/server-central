import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// OS-provided machine identifiers, in preference order. Stable across reboots
// and reconnects, which is exactly what we want for a fleet key.
const OS_MACHINE_ID_SOURCES = ["/etc/machine-id", "/var/lib/dbus/machine-id"];

/** Where we persist a generated id when the OS provides none. */
function stateDir(): string {
    return process.env.SC_AGENT_DIR || path.join(os.homedir(), ".sc-agent");
}

/** Hash the raw OS id so we never transmit the (somewhat sensitive) value itself. */
function hashId(raw: string): string {
    return createHash("sha256").update(`sc-agent:${raw}`).digest("hex").slice(0, 32);
}

async function persistedId(): Promise<string> {
    const file = path.join(stateDir(), "machine-id");
    try {
        const existing = (await fs.readFile(file, "utf8")).trim();
        if (existing) {
            return existing;
        }
    } catch { /* generate one below */ }

    const id = crypto.randomUUID().replace(/-/g, "");
    await fs.mkdir(stateDir(), { recursive: true });
    await fs.writeFile(file, id);
    return id;
}

/**
 * Resolve a stable identifier for this machine. Prefers the OS machine-id
 * (hashed); falls back to a UUID persisted under the agent's state dir. The
 * server keys the fleet on this, so reconnects and reinstalls map to the same
 * entry instead of creating duplicates.
 */
export async function resolveMachineId(): Promise<string> {
    for (const src of OS_MACHINE_ID_SOURCES) {
        try {
            const raw = (await fs.readFile(src, "utf8")).trim();
            if (raw) {
                return hashId(raw);
            }
        } catch { /* try next source */ }
    }
    return persistedId();
}
