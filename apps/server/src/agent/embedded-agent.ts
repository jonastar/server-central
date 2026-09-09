import * as os from "node:os";
import type { AgentConfigReport, MetricsSnapshot } from "@central/shared";
import { AGENT_CAPABILITIES } from "@central/shared";
import { Agent, type AgentTransport, collectSystemInfo, resolveMachineId } from "./agent";
import { probeHostCapabilities } from "./host-capabilities";
import { HostAgent } from "../host-agent";
import { controlPlaneInstallInfo } from "../server-install";

/**
 * Build the control plane's own host as a {@link HostAgent}, backed by an
 * in-process {@link Agent} instead of a WebSocket. The agent's NodeMessages are
 * fed straight back into the HostAgent, so the same code path serves the local
 * host and remote nodes — no method forwarding, just a different transport.
 *
 * Keyed on the real machine id and marked `embedded`, so a separate agent on the
 * same physical machine collapses to one fleet entry rather than a distinct
 * "local" host. The embedded agent has no install handler and never disconnects;
 * `embedded` outranks live/installed so it always stays the active connection.
 */
export async function createEmbeddedAgent(
    onMetrics: (serverId: string, snapshot: MetricsSnapshot) => void,
): Promise<HostAgent> {
    const machineId = await resolveMachineId();

    // The embedded agent is this same build, so it has every current capability.
    const host = new HostAgent(
        (ctrlMsg) => void agent.onMessage(ctrlMsg),
        machineId,
        os.hostname(),
        null,
        onMetrics,
        "embedded",
        null,
        AGENT_CAPABILITIES,
        await probeHostCapabilities(),
    );

    const transport: AgentTransport = { send: (nodeMsg) => host.receive(nodeMsg) };
    const agent = new Agent(transport, true, undefined, undefined, describeEmbeddedConfig);

    host.setInfo(await collectSystemInfo());
    agent.startMetrics();

    return host;
}

/**
 * The embedded agent's answer to `agentConfigRequest`. It has no launch config of
 * its own — no endpoint to dial, no cert to pin, no token — so it reports the
 * control plane's install instead, which is what "how is this agent configured"
 * actually means for the host the control plane runs on.
 *
 * Read per request rather than captured at startup so a control plane installed
 * *after* it first booted (the usual order: run it, like it, install it) starts
 * reporting its unit without a restart.
 */
async function describeEmbeddedConfig(): Promise<AgentConfigReport> {
    const info = await controlPlaneInstallInfo();
    return {
        configPath: null,
        control: null,
        altControl: null,
        cert: null,
        mode: "embedded",
        installDir: info.installDir,
        dataDir: info.dataDir,
        mechanism: info.mechanism,
        lastControl: null,
        lastControlAt: null,
        logUnit: info.logUnit,
    };
}
