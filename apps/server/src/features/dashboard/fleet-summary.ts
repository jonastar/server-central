import { stackRunStatus } from "@central/shared";
import type { ComposeStack, DockerStack, FleetHostSummary, FleetPoolSummary, FleetStackSummary, FleetSummary, HostCapability, ServerEntry, ZfsPool } from "@central/shared";
import type { Fleet } from "../../fleet";
import type { HostAgent } from "../../host-agent";
import { dockerFleetSnapshot } from "../docker/docker";
import { systemdFailedUnits } from "../systemd/systemd";
import { zfsGetState } from "../zfs/zfs";

/**
 * Collects {@link FleetSummary}: one fan-out over every online host, each
 * subsystem asked in parallel, each host given a deadline so one wedged docker
 * daemon can't hold the whole page.
 *
 * Results are cached for {@link CACHE_MS} and an in-flight collection is
 * shared, so however many tabs poll, the hosts see one round of commands per
 * window. The window is shorter than the browser's poll interval on purpose:
 * a page that just loaded should get a fresh answer, not one from up to ten
 * seconds ago, while ten tabs on the same cadence still collapse to one.
 */

const CACHE_MS = 5_000;
const HOST_TIMEOUT_MS = 8_000;

interface Sources {
    /** Registered compose stacks, for naming observed projects and listing the
     *  registered-but-not-running ones. */
    registeredStacks(): ComposeStack[];
}

export class FleetSummaryCollector {
    private cached: { at: number; value: FleetSummary } | null = null;
    private inFlight: Promise<FleetSummary> | null = null;

    constructor(private readonly fleet: Fleet, private readonly sources: Sources) { }

    get(): Promise<FleetSummary> {
        if (this.cached && Date.now() - this.cached.at < CACHE_MS) {
            return Promise.resolve(this.cached.value);
        }
        if (!this.inFlight) {
            this.inFlight = this.collect()
                .then((value) => {
                    this.cached = { at: value.capturedAt, value };
                    return value;
                })
                .finally(() => { this.inFlight = null; });
        }
        return this.inFlight;
    }

    private async collect(): Promise<FleetSummary> {
        const registered = this.sources.registeredStacks();
        const hosts = await Promise.all(
            this.fleet.entries()
                .filter((e) => e.status.state === "online")
                .map((entry) => summarizeHost(entry, this.fleet.get(entry.id), registered.filter((s) => s.hostId === entry.id))),
        );
        return { hosts, capturedAt: Date.now() };
    }
}

/** A capability the agent positively reported missing is not asked; unknown
 *  (older agent) still is — same call the tabs make. */
function has(entry: ServerEntry, capability: HostCapability): boolean {
    return entry.status.hostCapabilities?.[capability]?.available !== false;
}

function withDeadline<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer within ${HOST_TIMEOUT_MS / 1000}s`)), HOST_TIMEOUT_MS);
        work.then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

async function summarizeHost(entry: ServerEntry, agent: HostAgent, registered: ComposeStack[]): Promise<FleetHostSummary> {
    const out: FleetHostSummary = { hostId: entry.id, docker: null, failedUnits: null, pools: null, errors: {} };

    const ask = async <T>(capability: HostCapability, work: () => Promise<T>, apply: (value: T) => void) => {
        if (!has(entry, capability)) {
            return;
        }
        try {
            apply(await withDeadline(work()));
        } catch (err) {
            out.errors[capability] = err instanceof Error ? err.message : String(err);
        }
    };

    await Promise.all([
        ask("docker", () => dockerFleetSnapshot(agent), (snap) => {
            if (!snap.available) {
                out.errors.docker = snap.error;
                return;
            }
            out.docker = {
                containersRunning: snap.containersRunning,
                containersTotal: snap.containersTotal,
                containersCompleted: snap.containersCompleted,
                stacks: mergeStacks(snap.stacks, registered),
            };
        }),
        ask("systemd", () => systemdFailedUnits(agent), (res) => {
            if (!res.available) {
                out.errors.systemd = res.error;
                return;
            }
            out.failedUnits = res.units;
        }),
        ask("zfs", () => zfsGetState(agent), (state) => {
            if (!state.available) {
                out.errors.zfs = state.error ?? "ZFS unavailable";
                return;
            }
            out.pools = state.pools.map(summarizePool);
        }),
    ]);

    return out;
}

/** The same registered/observed merge the host's stacks widget does: observed
 *  projects carry the live state, a registration renames one, and a registered
 *  project nothing is running under is simply down. */
export function mergeStacks(observed: DockerStack[], registered: ComposeStack[]): FleetStackSummary[] {
    const byProject = new Map<string, FleetStackSummary>();
    for (const obs of observed) {
        byProject.set(obs.project, {
            project: obs.project,
            name: obs.project,
            status: stackRunStatus(obs.running, obs.containers, obs.completed),
            running: obs.running,
            total: obs.containers - obs.completed,
            completed: obs.completed,
        });
    }
    for (const stack of registered) {
        const existing = byProject.get(stack.project);
        byProject.set(stack.project, existing
            ? { ...existing, name: stack.name }
            : { project: stack.project, name: stack.name, status: "down", running: 0, total: 0, completed: 0 });
    }
    return [...byProject.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function summarizePool(pool: ZfsPool): FleetPoolSummary {
    const scan = pool.scan;
    return {
        name: pool.name,
        state: pool.state,
        capacityPct: pool.capacityPct,
        lastScrubAt: scan?.kind === "scrub" && scan.state === "completed" ? scan.finishedAt ?? null : null,
        scrubInProgress: scan?.state === "in_progress",
    };
}
