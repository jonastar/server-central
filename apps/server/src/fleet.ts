import type { MetricsSnapshot, ServerEntry } from "@central/shared";
import type { HostAgent } from "./agent";
import { LocalAgent } from "./local-agent";
import { type AgentRecord, readAgentState, writeAgentState } from "./config";

/**
 * Registry of host agents. Tracks currently-connected agents and persists
 * known agents to disk so previously-seen nodes appear as offline after restart.
 */
export class Fleet {
    private agents = new Map<string, HostAgent>();
    private knownAgents = new Map<string, AgentRecord>();

    constructor(
        private readonly onMetrics: (serverId: string, snapshot: MetricsSnapshot) => void,
        private readonly onServersChange: (servers: ServerEntry[]) => void = () => { },
    ) { }

    async init(): Promise<void> {
        const stored = await readAgentState();
        for (const record of Object.values(stored)) {
            this.knownAgents.set(record.id, record);
        }

        const local = new LocalAgent(this.onMetrics);
        await local.start();
        this.agents.set(local.id, local);
        this.knownAgents.set(local.id, {
            id: local.id,
            name: local.name,
            info: local.status().info,
            lastSeenAt: Date.now(),
        });
        void this.persistState();
    }

    get(serverId: string): HostAgent {
        const agent = this.agents.get(serverId);
        if (!agent) throw new Error(`Unknown server: ${serverId}`);
        return agent;
    }

    register(agent: HostAgent): void {
        this.agents.set(agent.id, agent);
        this.knownAgents.set(agent.id, {
            id: agent.id,
            name: agent.name,
            info: agent.status().info,
            lastSeenAt: Date.now(),
        });
        void this.persistState();
        this.onServersChange(this.entries());
    }

    deregister(id: string): void {
        this.agents.delete(id);
        const record = this.knownAgents.get(id);
        if (record) record.lastSeenAt = Date.now();
        void this.persistState();
        this.onServersChange(this.entries());
    }

    entries(): ServerEntry[] {
        const connected = new Set(this.agents.keys());
        const result: ServerEntry[] = [];

        for (const [id, agent] of this.agents) {
            result.push({ id, name: agent.name, status: agent.status() });
        }

        for (const [id, record] of this.knownAgents) {
            if (!connected.has(id)) {
                result.push({
                    id,
                    name: record.name,
                    status: { serverId: id, state: "offline", info: record.info },
                });
            }
        }

        return result;
    }

    metricsHistory(): Record<string, MetricsSnapshot[]> {
        const out: Record<string, MetricsSnapshot[]> = {};
        for (const [id, agent] of this.agents) out[id] = agent.history;
        return out;
    }

    private async persistState(): Promise<void> {
        const state: Record<string, AgentRecord> = {};
        for (const [id, record] of this.knownAgents) state[id] = record;
        await writeAgentState(state);
    }
}
