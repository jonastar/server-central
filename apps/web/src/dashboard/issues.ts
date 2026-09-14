import type { FleetHostSummary, MetricsSnapshot, ServerEntry } from "@central/shared";
import type { Route } from "../routes";
import { fmtPct, fmtRelative, type Tone } from "../utils";

/**
 * What's worth pointing out about a host, as one list both overviews share:
 * the fleet page shows every host's, the host page shows its own.
 *
 * Tones are deliberately conservative — an overview that cries wolf gets
 * ignored. `err` is reserved for "this is broken right now" (host unreachable,
 * pool not ONLINE, disk about to fill); `warn` for "something is degraded"
 * (a stack partly up, a failed unit, a subsystem not answering, a disk past
 * the first threshold); `muted` for facts an operator wants to know but may
 * well have chosen (a stack that's stopped, a scrub that's overdue, an agent
 * behind the control plane). Task failures aren't here at all: a failed run
 * stays in its history whether or not it's been dealt with, so it can't tell
 * an open problem from a closed one.
 */

export interface HostIssue {
    tone: Tone;
    /** What's wrong, in one short noun phrase ("stack degraded"). */
    kind: string;
    subject: string;
    detail?: string;
    route: Route;
}

export const DISK_WARN_PCT = 85;
export const DISK_ERR_PCT = 95;
export const SCRUB_STALE_MS = 30 * 86_400_000;

export const TONE_RANK: Record<Tone, number> = { err: 0, warn: 1, muted: 2, ok: 3 };

export function worstTone(issues: Array<{ tone: Tone }>): Tone {
    return issues.reduce<Tone>((acc, i) => (TONE_RANK[i.tone] < TONE_RANK[acc] ? i.tone : acc), "ok");
}

export function usedPct(used: number, total: number): number {
    return total > 0 ? (used / total) * 100 : 0;
}

export function collectHostIssues(
    entry: ServerEntry,
    latest: MetricsSnapshot | undefined,
    summary: FleetHostSummary | undefined,
    agentOutdated: boolean,
): HostIssue[] {
    const out: HostIssue[] = [];
    const now = Date.now();
    const at = (tab: Extract<Route, { view: "server" }>["tab"], extra: Partial<Extract<Route, { view: "server" }>> = {}): Route =>
        ({ view: "server", serverId: entry.id, tab, ...extra });

    const { status } = entry;
    if (status.state === "offline") {
        out.push({ tone: "err", kind: "offline", subject: entry.name, detail: status.lastSeenAt ? `last seen ${fmtRelative(status.lastSeenAt)}` : undefined, route: at("overview") });
        return out;
    }
    if (status.state === "error") {
        out.push({ tone: "err", kind: "connection error", subject: entry.name, detail: status.error, route: at("overview") });
        return out;
    }

    for (const stack of summary?.docker?.stacks ?? []) {
        if (stack.status === "partial") {
            out.push({ tone: "warn", kind: "stack degraded", subject: stack.name, detail: `${stack.running}/${stack.total} containers`, route: at("docker", { section: "stacks" }) });
        } else if (stack.status !== "running") {
            // Stopped is a state someone may well have chosen; say so quietly.
            out.push({ tone: "muted", kind: "stack stopped", subject: stack.name, detail: stack.total ? `${stack.running}/${stack.total} containers` : "nothing running", route: at("docker", { section: "stacks" }) });
        }
    }
    for (const pool of summary?.pools ?? []) {
        if (pool.state !== "ONLINE") {
            out.push({ tone: "err", kind: `pool ${pool.state.toLowerCase()}`, subject: pool.name, route: at("zfs") });
        } else if (!pool.scrubInProgress && (pool.lastScrubAt === null || now - pool.lastScrubAt > SCRUB_STALE_MS)) {
            out.push({ tone: "muted", kind: "scrub overdue", subject: pool.name, detail: pool.lastScrubAt === null ? "never scrubbed" : `last ${fmtRelative(pool.lastScrubAt)}`, route: at("zfs") });
        }
    }
    if (summary?.failedUnits?.length) {
        out.push({
            tone: "warn",
            kind: summary.failedUnits.length === 1 ? "failed unit" : `${summary.failedUnits.length} failed units`,
            subject: summary.failedUnits.join(", "),
            route: at("services"),
        });
    }
    for (const [subsystem, error] of Object.entries(summary?.errors ?? {})) {
        out.push({ tone: "warn", kind: `${subsystem} not answering`, subject: entry.name, detail: error, route: at("overview") });
    }
    for (const disk of latest?.disks ?? []) {
        const used = usedPct(disk.usedKb, disk.totalKb);
        if (used >= DISK_WARN_PCT) {
            out.push({ tone: used >= DISK_ERR_PCT ? "err" : "warn", kind: "disk filling", subject: disk.mount, detail: `${fmtPct(used)} used`, route: at("mounts") });
        }
    }
    if (agentOutdated) {
        out.push({ tone: "muted", kind: "agent update", subject: status.info?.agentVersion ?? "", detail: "update available", route: { view: "agents" } });
    }
    return out.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
}
