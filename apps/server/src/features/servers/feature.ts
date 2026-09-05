import type { HostCapabilityReport, InstallMechanism, InstallProbeResult, MetricsSnapshot, ServerEntry, TaskUpdateAgent, TaskUpdateAgentResult } from "@central/shared";
import { AGENT_VERSION } from "@central/shared";
import { readConfig } from "../../config";
import { defineFeature } from "../../feature";
import type { Fleet } from "../../fleet";
import type { NodeServer } from "../../node-server";
import type { HostAgent } from "../../host-agent";
import { requireAgent, type TaskCtx } from "../../tasks/types";

// The fleet of managed hosts: the server list, their metrics history, and
// enrolling/promoting an agent to an installed service. Fleet and NodeServer stay
// top-level infra (every other feature resolves hosts through the fleet); this is
// only the API slice over them.

export function createServersFeature(fleet: Fleet, nodeServer: NodeServer | null) {
    /** Enrollment needs the node server; it's null only if TLS/listener startup
     *  failed, in which case there's nothing for an agent to connect to anyway. */
    function requireNodeServer(): NodeServer {
        if (!nodeServer) {
            throw new Error("Node server not initialized");
        }
        return nodeServer;
    }

    return defineFeature({
        id: "servers",
        name: "Servers",
        description: "The managed-host fleet: enrollment, agent install, and metrics history.",
        experimental: false,
        ops: {
            async list() {
                return fleet.entries();
            },

            async delete(data) {
                fleet.remove(data.serverId);
            },

            /** Not owner-gated: re-probing reads the host's own state and changes
             *  nothing on it, same as the other read paths here. */
            async redetectCapabilities(data) {
                const report = await fleet.get(data.serverId).redetectHostCapabilities();
                // The report rides on ServerStatus, so push the refreshed list rather
                // than relying on the caller's response alone — every open client's
                // sidebar needs to stop (or start) greying the affected tabs.
                fleet.notifyServersChanged();
                return report;
            },

            async getMetricsHistory(data) {
                return fleet.get(data.serverId).history;
            },

            async generateInstallCommand(data) {
                const server = requireNodeServer();
                const config = await readConfig();
                return server.generateInstallCommand(data.platform, config.domain ?? null, data.useExternal ?? false);
            },

            async probeInstallPath(data) {
                return fleet.get(data.serverId).probeInstallPath(data.path);
            },

            async installService(data) {
                const server = requireNodeServer();
                const agent = fleet.get(data.serverId);
                if (agent.status().state !== "online") {
                    throw new Error("Agent is not connected");
                }
                if (agent.mode !== "live") {
                    throw new Error(agent.mode === "embedded"
                        ? "The control plane's own host can't be installed as a service"
                        : "Agent is already installed as a service");
                }
                const installDir = data.installDir?.trim() || null;
                const dataDir = data.dataDir?.trim() || null;

                // Durable token keyed by machine id (the fleet's serverId). The agent
                // validates the chosen paths (writable + exec) before writing anything.
                const agentToken = await server.mintAgentToken(data.serverId);
                const startCommand = await agent.installService(agentToken, installDir, dataDir, data.mechanism, data.force);
                return { startCommand };
            },
        },
        tasks: {
            async update_agent(spec, ctx) {
                const agent = requireAgent(ctx, "update_agent");
                const current = agent.status().info?.agentVersion;
                if (agent.status().state !== "online") {
                    throw new Error("Agent is not connected");
                }
                if (agent.mode !== "installed") {
                    throw new Error("Only installed agents can be updated");
                }
                if (current === AGENT_VERSION && !spec.force) {
                    throw new Error("Agent is already up to date");
                }
                if (!ctx.target) {
                    throw new Error("update_agent requires a target host");
                }
                ctx.log(`Updating ${current ?? "unknown"} -> ${AGENT_VERSION}${spec.force ? " (forced)" : ""}`);
                await agent.updateService(AGENT_VERSION, spec.force);
                ctx.log("Update acknowledged by agent; waiting for it to reconnect on the new binary...");
                await waitForAgentReconnect(ctx, ctx.target, agent, AGENT_VERSION, spec.force);
                ctx.log("Agent reconnected — update complete.");
                return { kind: "update_agent" };
            },
        },
    });
}

// ---- Task kinds --------------------------------------------------------------
//
// `update_agent` is agent lifecycle — the same permission that covers enrollment
// and install above, and the only kind that re-resolves its target mid-run.


/** Cooperative sleep — resolves early (without throwing) if the run is aborted,
 *  so a polling loop's own `while` condition is what actually stops it. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
}

const RECONNECT_POLL_MS = 2_000;
const RECONNECT_TIMEOUT_MS = 5 * 60_000;

/**
 * Wait for the agent to come back as a *new* connection (proof it actually
 * disconnected to swap its binary and restart, not just still being the old
 * process) — polling `fleet.get` since the old `HostAgent` object is gone from
 * the fleet the moment it disconnects and won't itself flip back online.
 * Version-checked when possible, but a `force` re-push (same version string,
 * rebuilt binary) can't be told apart from the old connection that way, so it
 * settles for "a new connection came back online" instead.
 */
async function waitForAgentReconnect(ctx: TaskCtx, target: string, before: HostAgent, expectedVersion: string, force: boolean | undefined): Promise<void> {
    const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (ctx.signal.aborted) {
            throw new Error("Cancelled");
        }
        await sleep(RECONNECT_POLL_MS, ctx.signal);
        let agent: HostAgent;
        try {
            agent = ctx.fleet.get(target);
        } catch {
            continue; // mid-reconnect gap: deregistered, not yet re-registered
        }
        if (agent === before || agent.status().state !== "online") {
            continue;
        }
        // A new, online connection for this machine IS the reconnect — it's not
        // going to spontaneously change version from here, so a mismatch is the
        // final answer, not a "still settling" state worth continuing to poll for.
        const reportedVersion = agent.status().info?.agentVersion;
        if (!force && reportedVersion !== expectedVersion) {
            throw new Error(`Agent reconnected on ${reportedVersion ?? "an unknown version"}, expected ${expectedVersion}`);
        }
        return;
    }
    throw new Error(`Agent did not reconnect within ${Math.round(RECONNECT_TIMEOUT_MS / 1000)}s of the update being pushed`);
}

