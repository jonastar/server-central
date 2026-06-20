import type {
    ApiHandler,
    CentralApiOperations,
    ContainerAction,
    DirEntry,
    DockerState,
    FileContent,
    MetricsSnapshot,
    ProcessInfo,
    ServerEntry,
    UserInfo,
} from "@central/shared";
import { dockerContainerAction, dockerContainerLogs, dockerList } from "./docker";
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
        if (!ctx?.user) throw new Error("Not authenticated");
        return ctx.user;
    }

    // ---- Servers --------------------------------------------------------------

    async getServers(): Promise<ServerEntry[]> {
        return this.fleet.entries();
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

    // ---- Node enrollment ---------------------------------------------------------------

    async generateNodeInstallCommand(data: { platform: "linux" | "mac" | "windows" }): Promise<{ command: string; expiresAt: number }> {
        if (!this.nodeServer) throw new Error("Node server not initialized");
        const config = await readConfig();
        return this.nodeServer.generateInstallCommand(data.platform, config.domain ?? null);
    }

    async installNodeService(data: { serverId: string }): Promise<void> {
        if (!this.nodeServer) throw new Error("Node server not initialized");
        const agent = this.fleet.get(data.serverId);
        if (agent.status().state !== "online") throw new Error("Agent is not connected");
        if (agent.mode === "installed") throw new Error("Agent is already installed as a service");
        if (!agent.installService) throw new Error("This agent cannot be installed as a service");

        // Durable token keyed by machine id (the fleet's serverId).
        const agentToken = await this.nodeServer.mintAgentToken(data.serverId);
        await agent.installService(agentToken);
    }

    // ---- Config ------------------------------------------------------------------------

    async getConfig(): Promise<{ domain: string | null }> {
        const config = await readConfig();
        return { domain: config.domain ?? null };
    }

    async setDomain(data: { domain: string | null }): Promise<void> {
        await persistSetDomain(data.domain);
    }

    // ---- Processes ---------------------------------------------------------------------

    async getProcesses(data: { serverId: string }): Promise<ProcessInfo[]> {
        const res = await this.fleet.get(data.serverId).exec("ps aux");
        const out: ProcessInfo[] = [];
        for (const line of res.stdout.split("\n").slice(1)) {
            const f = line.trim().split(/\s+/);
            if (f.length < 11) continue;
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
}
