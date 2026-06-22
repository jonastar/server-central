import type {
    ApiHandler,
    CentralApiOperations,
    ContainerAction,
    DirEntry,
    DockerContainerDetail,
    DockerOverview,
    DockerStacksState,
    DockerState,
    DockerVolumeDetail,
    FileContent,
    ImageAction,
    InstallMechanism,
    InstallProbeResult,
    MetricsSnapshot,
    NetworkInfo,
    ProcessInfo,
    ServerEntry,
    ServiceAction,
    StackAction,
    SystemdState,
    UserInfo,
} from "@central/shared";
import { AGENT_VERSION } from "@central/shared";
import {
    dockerContainerAction,
    dockerContainerInspect,
    dockerContainerLogs,
    dockerImageAction,
    dockerImagePull,
    dockerList,
    dockerOverview,
    dockerStackAction,
    dockerStacks,
    dockerVolumeInspect,
    dockerVolumeRemove,
} from "./docker";
import { getNetworkInfo } from "./network";
import { systemdList, systemdServiceAction, systemdServiceLogs, systemdUnitFile } from "./systemd";
import type { AuthContext, AuthStore } from "./auth";
import type { Fleet } from "./fleet";
import type { NodeServer } from "./node-server";
import { readConfig, setDomain as persistSetDomain } from "./config";

export class CentralHandler implements ApiHandler<CentralApiOperations> {
    constructor(
        private readonly fleet: Fleet,
        private readonly auth: AuthStore,
        private readonly nodeServer: NodeServer | null = null,
    ) { }

    // ---- Auth -----------------------------------------------------------------

    async getAuthState(_data: void, ctx?: AuthContext): Promise<{ needsSetup: boolean; user: UserInfo | null }> {
        return { needsSetup: this.auth.needsSetup(), user: ctx?.user ?? null };
    }

    async setupOwner(data: { username: string; password: string }): Promise<{ token: string; user: UserInfo }> {
        return this.auth.setupOwner(data.username, data.password);
    }

    async login(data: { username: string; password: string }): Promise<{ token: string; user: UserInfo }> {
        return this.auth.login(data.username, data.password);
    }

    async logout(_data: void, ctx?: AuthContext): Promise<void> {
        await this.auth.logout(ctx?.token ?? null);
    }

    async me(_data: void, ctx?: AuthContext): Promise<UserInfo> {
        if (!ctx?.user) {
            throw new Error("Not authenticated");
        }
        return ctx.user;
    }

    // ---- Servers --------------------------------------------------------------

    async getServers(): Promise<ServerEntry[]> {
        return this.fleet.entries();
    }

    async deleteServer(data: { serverId: string }): Promise<void> {
        this.fleet.remove(data.serverId);
    }

    // ---- Metrics ----------------------------------------------------------------

    async getMetricsHistory(data: { serverId: string }): Promise<MetricsSnapshot[]> {
        return this.fleet.get(data.serverId).history;
    }

    // ---- Files --------------------------------------------------------------------

    async listDir(data: { serverId: string; path: string }): Promise<{ path: string; entries: DirEntry[] }> {
        return this.fleet.get(data.serverId).listDir(data.path);
    }

    async readFile(data: { serverId: string; path: string }): Promise<FileContent> {
        return this.fleet.get(data.serverId).readFile(data.path);
    }

    async writeFile(data: { serverId: string; path: string; content: string }): Promise<void> {
        await this.fleet.get(data.serverId).writeFile(data.path, data.content);
    }

    async createDir(data: { serverId: string; path: string }): Promise<void> {
        await this.fleet.get(data.serverId).createDir(data.path);
    }

    async deletePath(data: { serverId: string; path: string }): Promise<void> {
        await this.fleet.get(data.serverId).deletePath(data.path);
    }

    async renamePath(data: { serverId: string; from: string; to: string }): Promise<void> {
        await this.fleet.get(data.serverId).renamePath(data.from, data.to);
    }

    // ---- Docker ----------------------------------------------------------------------

    async dockerList(data: { serverId: string }): Promise<DockerState> {
        return dockerList(this.fleet.get(data.serverId));
    }

    async dockerContainerAction(data: { serverId: string; containerId: string; action: ContainerAction }): Promise<void> {
        await dockerContainerAction(this.fleet.get(data.serverId), data.containerId, data.action);
    }

    async dockerContainerLogs(data: { serverId: string; containerId: string; tail?: number }): Promise<{ logs: string }> {
        return { logs: await dockerContainerLogs(this.fleet.get(data.serverId), data.containerId, data.tail ?? 500) };
    }

    async dockerOverview(data: { serverId: string }): Promise<DockerOverview> {
        return dockerOverview(this.fleet.get(data.serverId));
    }

    async dockerStacks(data: { serverId: string }): Promise<DockerStacksState> {
        return dockerStacks(this.fleet.get(data.serverId));
    }

    async dockerStackAction(data: { serverId: string; project: string; action: StackAction }): Promise<void> {
        await dockerStackAction(this.fleet.get(data.serverId), data.project, data.action);
    }

    async dockerContainerInspect(data: { serverId: string; containerId: string }): Promise<DockerContainerDetail> {
        return dockerContainerInspect(this.fleet.get(data.serverId), data.containerId);
    }

    async dockerVolumeInspect(data: { serverId: string; name: string }): Promise<DockerVolumeDetail> {
        return dockerVolumeInspect(this.fleet.get(data.serverId), data.name);
    }

    async dockerVolumeRemove(data: { serverId: string; name: string }): Promise<void> {
        await dockerVolumeRemove(this.fleet.get(data.serverId), data.name);
    }

    async dockerImageAction(data: { serverId: string; imageId: string; action: ImageAction }): Promise<void> {
        await dockerImageAction(this.fleet.get(data.serverId), data.imageId, data.action);
    }

    async dockerImagePull(data: { serverId: string; ref: string }): Promise<{ ok: boolean; message: string }> {
        return dockerImagePull(this.fleet.get(data.serverId), data.ref);
    }

    // ---- Node enrollment ---------------------------------------------------------------

    async generateNodeInstallCommand(data: { platform: "linux" | "mac" | "windows"; useExternal?: boolean }): Promise<{ command: string; expiresAt: number; externalHost: string | null }> {
        if (!this.nodeServer) {
            throw new Error("Node server not initialized");
        }
        const config = await readConfig();
        return this.nodeServer.generateInstallCommand(data.platform, config.domain ?? null, data.useExternal ?? false);
    }

    async probeInstallPath(data: { serverId: string; path: string }): Promise<InstallProbeResult> {
        return this.fleet.get(data.serverId).probeInstallPath(data.path);
    }

    async installNodeService(data: { serverId: string; installDir: string | null; dataDir: string | null; mechanism: InstallMechanism }): Promise<{ startCommand: string | null }> {
        if (!this.nodeServer) {
            throw new Error("Node server not initialized");
        }
        const agent = this.fleet.get(data.serverId);
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
        const agentToken = await this.nodeServer.mintAgentToken(data.serverId);
        const startCommand = await agent.installService(agentToken, installDir, dataDir, data.mechanism);
        return { startCommand };
    }

    async updateNodeService(data: { serverId: string }): Promise<void> {
        const agent = this.fleet.get(data.serverId);
        if (agent.status().state !== "online") {
            throw new Error("Agent is not connected");
        }
        if (agent.mode !== "installed") {
            throw new Error("Only installed agents can be updated");
        }
        if (agent.status().info?.agentVersion === AGENT_VERSION) {
            throw new Error("Agent is already up to date");
        }
        await agent.updateService(AGENT_VERSION);
    }

    // ---- Config ------------------------------------------------------------------------

    async getConfig(): Promise<{ domain: string | null }> {
        const config = await readConfig();
        return { domain: config.domain ?? null };
    }

    async setDomain(data: { domain: string | null }): Promise<void> {
        await persistSetDomain(data.domain);
        // Re-issue the leaf so it carries the new domain in its SAN; agents trust the
        // CA, so this takes effect without re-enrolling anything.
        await this.nodeServer?.refreshTls();
    }

    // ---- Processes ---------------------------------------------------------------------

    async getProcesses(data: { serverId: string }): Promise<ProcessInfo[]> {
        const res = await this.fleet.get(data.serverId).exec("ps aux");
        const out: ProcessInfo[] = [];
        for (const line of res.stdout.split("\n").slice(1)) {
            const f = line.trim().split(/\s+/);
            if (f.length < 11) {
                continue;
            }
            out.push({
                user: f[0],
                pid: Number(f[1]),
                cpuPct: Number(f[2]) || 0,
                memPct: Number(f[3]) || 0,
                rssKb: Number(f[5]) || 0,
                started: f[8],
                command: f.slice(10).join(" "),
            });
        }
        return out.sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 300);
    }

    // ---- Networking --------------------------------------------------------------------

    async getNetworkInfo(data: { serverId: string }): Promise<NetworkInfo> {
        return getNetworkInfo(this.fleet.get(data.serverId));
    }

    // ---- Systemd -----------------------------------------------------------------------

    async systemdList(data: { serverId: string }): Promise<SystemdState> {
        return systemdList(this.fleet.get(data.serverId));
    }

    async systemdServiceAction(data: { serverId: string; unit: string; action: ServiceAction }): Promise<void> {
        await systemdServiceAction(this.fleet.get(data.serverId), data.unit, data.action);
    }

    async systemdServiceLogs(data: { serverId: string; unit: string; lines?: number }): Promise<{ logs: string }> {
        return { logs: await systemdServiceLogs(this.fleet.get(data.serverId), data.unit, data.lines ?? 300) };
    }

    async systemdUnitFile(data: { serverId: string; unit: string }): Promise<{ content: string }> {
        return { content: await systemdUnitFile(this.fleet.get(data.serverId), data.unit) };
    }
}
