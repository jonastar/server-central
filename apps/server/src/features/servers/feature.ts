import type { InstallMechanism, InstallProbeResult, MetricsSnapshot, ServerEntry } from "@central/shared";
import { readConfig } from "../../config";
import type { Feature, FeatureApiHandlers } from "../../feature";
import type { Fleet } from "../../fleet";
import type { NodeServer } from "../../node-server";

// The fleet of managed hosts: the server list, their metrics history, and
// enrolling/promoting an agent to an installed service. Fleet and NodeServer stay
// top-level infra (every other feature resolves hosts through the fleet); this is
// only the API slice over them.

export function createServersFeature(fleet: Fleet, nodeServer: NodeServer | null): Feature<ServersOps> {
    return {
        descriptor: {
            id: "servers",
            name: "Servers",
            description: "The managed-host fleet: enrollment, agent install, and metrics history.",
            experimental: false,
        },
        apiHandlers() {
            return serversApiHandlers(fleet, nodeServer);
        },
    };
}

export type ServersOps = "getServers" | "deleteServer" | "getMetricsHistory"
    | "generateNodeInstallCommand" | "probeInstallPath" | "installNodeService";

export function serversApiHandlers(fleet: Fleet, nodeServer: NodeServer | null): FeatureApiHandlers<ServersOps> {
    /** Enrollment needs the node server; it's null only if TLS/listener startup
     *  failed, in which case there's nothing for an agent to connect to anyway. */
    function requireNodeServer(): NodeServer {
        if (!nodeServer) {
            throw new Error("Node server not initialized");
        }
        return nodeServer;
    }

    return {
        async handleGetServers(): Promise<ServerEntry[]> {
            return fleet.entries();
        },

        async handleDeleteServer(data: { serverId: string }): Promise<void> {
            fleet.remove(data.serverId);
        },

        async handleGetMetricsHistory(data: { serverId: string }): Promise<MetricsSnapshot[]> {
            return fleet.get(data.serverId).history;
        },

        async handleGenerateNodeInstallCommand(data: { platform: "linux" | "mac" | "windows"; useExternal?: boolean }): Promise<{ command: string; expiresAt: number; externalHost: string | null }> {
            const server = requireNodeServer();
            const config = await readConfig();
            return server.generateInstallCommand(data.platform, config.domain ?? null, data.useExternal ?? false);
        },

        async handleProbeInstallPath(data: { serverId: string; path: string }): Promise<InstallProbeResult> {
            return fleet.get(data.serverId).probeInstallPath(data.path);
        },

        async handleInstallNodeService(data: { serverId: string; installDir: string | null; dataDir: string | null; mechanism: InstallMechanism; force?: boolean }): Promise<{ startCommand: string | null }> {
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
    };
}
