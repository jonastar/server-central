// ---- Host capabilities -----------------------------------------------------------
//
// Probeable facts about a *managed host* — "is this subsystem actually usable
// here". Distinct from the two other things this codebase calls capabilities:
// AGENT_CAPABILITIES (which protocol message kinds an agent build understands, a
// function of agent version) and the planned RBAC capabilities (what a user may
// do). These are a function of the machine, and can change while the agent runs.
//
// Answered by the agent natively — filesystem and /proc checks, not shelling out
// — so "installed" is distinguished from "actually usable" (a zfs binary with no
// kernel module, a docker socket the agent can't open). Reported unprompted at
// identify and re-runnable on demand; see agent/host-capabilities.ts.

/** Ids are protocol surface: features declare one, agents implement one. */
export type HostCapability = "zfs" | "systemd" | "docker";

export const HOST_CAPABILITIES: readonly HostCapability[] = ["zfs", "systemd", "docker"];

export interface HostCapabilityResult {
    available: boolean;
    /** Why it's unavailable (or a note when it is) — surfaced verbatim in the UI,
     *  so it should name the thing to install or fix. */
    detail?: string;
}

/**
 * Every probe an agent answered, keyed by id.
 *
 * A capability *absent* from the map is **unknown**, not unavailable — the agent
 * predates that probe, or hasn't reported yet. Unknown must render as normally
 * available: an offline or older host has undetermined capabilities, and treating
 * that as "no" would grey out every tab on each reconnect.
 */
export type HostCapabilityReport = Partial<Record<HostCapability, HostCapabilityResult>>;

