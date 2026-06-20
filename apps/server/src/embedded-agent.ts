import * as os from "node:os";
import type { MetricsSnapshot } from "@central/shared";
import { Agent, type AgentTransport, collectSystemInfo, resolveMachineId } from "./agent";
import { HostAgent } from "./host-agent";

/**
 * Build the control plane's own host as a {@link HostAgent}, backed by an
 * in-process {@link Agent} instead of a WebSocket. The agent's NodeMessages are
 * fed straight back into the HostAgent, so the same code path serves the local
 * host and remote nodes — no method forwarding, just a different transport.
 *
 * Keyed on the real machine id and marked `installed`, so a separate agent on the
 * same physical machine collapses to one fleet entry rather than a distinct
 * "local" host. The embedded agent has no install handler and never disconnects.
 */
export async function createEmbeddedAgent(
    onMetrics: (serverId: string, snapshot: MetricsSnapshot) => void,
): Promise<HostAgent> {
    const machineId = await resolveMachineId();

    const host = new HostAgent(
        (ctrlMsg) => void agent.onMessage(ctrlMsg),
        machineId,
        os.hostname(),
        null,
        onMetrics,
        "installed",
    );

    const transport: AgentTransport = { send: (nodeMsg) => host.receive(nodeMsg) };
    const agent = new Agent(transport, true);

    host.setInfo(await collectSystemInfo());
    agent.startMetrics();

    return host;
}
