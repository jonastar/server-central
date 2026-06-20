import type { AgentMode, MetricsSnapshot, ServerEntry } from "@central/shared";
import { HostAgent } from "./host-agent";
import { createEmbeddedAgent } from "./embedded-agent";
import { type AgentRecord, readAgentState, writeAgentState } from "./config";

/** Higher wins when two agents claim the same machine. */
const MODE_RANK: Record<AgentMode, number> = { live: 1, installed: 2 };

/**
 * Registry of host agents. Agents are keyed by a stable machine id, so a node
 * reconnecting — or running both a live and an installed agent — maps to a
 * single entry. All connections for a machine are tracked; the highest-priority
 * one (installed > live, newer wins on a tie) is active and the rest are demoted
 * to standby/dummy but stay visible. If the active one disconnects, a standby is
 * promoted in its place.
 *
 * Known agents are persisted to disk so previously-seen nodes appear as offline
 * after restart.
 */
export class Fleet {
    /** machineId → every connected agent for that machine, in arrival order. */
    private connections = new Map<string, HostAgent[]>();
    private knownAgents = new Map<string, AgentRecord>();

    constructor(
        private readonly onMetrics: (serverId: string, snapshot: MetricsSnapshot) => void,
        private readonly onServersChange: (servers: ServerEntry[]) => void = () => { },
    ) { }

    async init(): Promise<void> {
        const stored = await readAgentState();
        for (const record of Object.values(stored)) {
            // Drop the legacy embedded-agent record: the embedded agent now keys
            // on the real machine id, so a leftover "local" would be a phantom.
            if (record.id === "local") continue;
            this.knownAgents.set(record.id, record);
        }

        const local = await createEmbeddedAgent(this.onMetrics);
        this.connections.set(local.id, [local]);
        this.recordAgent(local);
        void this.persistState();
    }

    /** The active (highest-priority, newest-on-tie) agent among a machine's connections. */
    private activeOf(list: HostAgent[]): HostAgent | undefined {
        let best: HostAgent | undefined;
        for (const a of list) {
            if (!best || MODE_RANK[a.mode] >= MODE_RANK[best.mode]) best = a;
        }
        return best;
    }

    /** Apply active/standby state across a machine's connections; returns the active one. */
    private reconcile(list: HostAgent[]): HostAgent {
        const active = this.activeOf(list)!;
        for (const a of list) {
            if (a === active) a.activate?.();
            else a.deactivate?.();
        }
        return active;
    }

    get(serverId: string): HostAgent {
        const list = this.connections.get(serverId);
        const active = list && this.activeOf(list);
        if (!active) throw new Error(`Unknown server: ${serverId}`);
        return active;
    }

    /**
     * Register a connected agent under its machine id. Tracks it alongside any
     * other connections for that machine and (re)computes which one is active.
     * Returns whether `agent` became the active one.
     */
    register(agent: HostAgent): boolean {
        const list = this.connections.get(agent.id) ?? [];
        if (!list.includes(agent)) list.push(agent);
        this.connections.set(agent.id, list);

        const active = this.reconcile(list);
        this.recordAgent(active);
        void this.persistState();
        this.onServersChange(this.entries());
        return agent === active;
    }

    deregister(agent: HostAgent): void {
        const list = this.connections.get(agent.id);
        if (!list) return;
        const idx = list.indexOf(agent);
        if (idx === -1) return;
        list.splice(idx, 1);

        if (list.length === 0) {
            this.connections.delete(agent.id);
            const record = this.knownAgents.get(agent.id);
            if (record) record.lastSeenAt = Date.now();
        } else {
            // Promote a standby to active if the one that left was active.
            this.recordAgent(this.reconcile(list));
        }
        void this.persistState();
        this.onServersChange(this.entries());
    }

    private recordAgent(agent: HostAgent): void {
        this.knownAgents.set(agent.id, {
            id: agent.id,
            name: agent.name,
            info: agent.status().info,
            mode: agent.mode,
            lastSeenAt: Date.now(),
        });
    }

    entries(): ServerEntry[] {
        const result: ServerEntry[] = [];

        for (const [id, list] of this.connections) {
            const active = this.activeOf(list)!;
            const standbys = list
                .filter((a) => a !== active)
                .map((a) => ({ name: a.name, mode: a.mode, agentVersion: a.status().info?.agentVersion }));
            result.push({
                id,
                name: active.name,
                status: { ...active.status(), standbys: standbys.length ? standbys : undefined },
            });
        }

        for (const [id, record] of this.knownAgents) {
            if (!this.connections.has(id)) {
                result.push({
                    id,
                    name: record.name,
                    status: { serverId: id, state: "offline", info: record.info, mode: record.mode, lastSeenAt: record.lastSeenAt },
                });
            }
        }

        return result;
    }

    metricsHistory(): Record<string, MetricsSnapshot[]> {
        const out: Record<string, MetricsSnapshot[]> = {};
        for (const [id, list] of this.connections) {
            const active = this.activeOf(list);
            if (active) out[id] = active.history;
        }
        return out;
    }

    private async persistState(): Promise<void> {
        const state: Record<string, AgentRecord> = {};
        for (const [id, record] of this.knownAgents) state[id] = record;
        await writeAgentState(state);
    }
}
