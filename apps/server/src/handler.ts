import type {
    ApiHandlerPrefixed,
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
import { controlPlaneStatus, updateControlPlane } from "./server-install";

export class CentralHandler implements ApiHandlerPrefixed<CentralApiOperations> {
    constructor(
        private readonly fleet: Fleet,
        private readonly auth: AuthStore,
        private readonly nodeServer: NodeServer | null = null,
    ) { }

    // ---- Auth -----------------------------------------------------------------

    async handleGetAuthState(_data: void, ctx?: AuthContext): Promise<{ needsSetup: boolean; user: UserInfo | null }> {
        return { needsSetup: this.auth.needsSetup(), user: ctx?.user ?? null };
    }

    async handleSetupOwner(data: { username: string; password: string }): Promise<{ token: string; user: UserInfo }> {
        return this.auth.setupOwner(data.username, data.password);
    }

    async handleLogin(data: { username: string; password: string }, ctx?: AuthContext): Promise<{ token: string; user: UserInfo }> {
        return this.auth.login(data.username, data.password, ctx?.ip ?? null);
    }

    async handleLogout(_data: void, ctx?: AuthContext): Promise<void> {
        await this.auth.logout(ctx?.token ?? null);
    }

    async handleMe(_data: void, ctx?: AuthContext): Promise<UserInfo> {
        if (!ctx?.user) {
            throw new Error("Not authenticated");
        }
        return ctx.user;
    }

    // ---- Servers --------------------------------------------------------------

    async handleGetServers(): Promise<ServerEntry[]> {
        return this.fleet.entries();
    }

    async handleDeleteServer(data: { serverId: string }): Promise<void> {
        this.fleet.remove(data.serverId);
    }

    // ---- Metrics ----------------------------------------------------------------

    async handleGetMetricsHistory(data: { serverId: string }): Promise<MetricsSnapshot[]> {
        return this.fleet.get(data.serverId).history;
    }

    // ---- Files --------------------------------------------------------------------

    async handleListDir(data: { serverId: string; path: string }): Promise<{ path: string; entries: DirEntry[] }> {
        return this.fleet.get(data.serverId).listDir(data.path);
    }

    async handleReadFile(data: { serverId: string; path: string }): Promise<FileContent> {
        return this.fleet.get(data.serverId).readFile(data.path);
    }

    async handleWriteFile(data: { serverId: string; path: string; content: string }): Promise<void> {
        await this.fleet.get(data.serverId).writeFile(data.path, data.content);
    }

    async handleUploadFile(data: { serverId: string; path: string; contentBase64: string }): Promise<void> {
        await this.fleet.get(data.serverId).uploadFile(data.path, data.contentBase64);
    }

    async handleCreateDir(data: { serverId: string; path: string }): Promise<void> {
        await this.fleet.get(data.serverId).createDir(data.path);
    }

    async handleDeletePath(data: { serverId: string; path: string }): Promise<void> {
        await this.fleet.get(data.serverId).deletePath(data.path);
    }

    async handleRenamePath(data: { serverId: string; from: string; to: string }): Promise<void> {
        await this.fleet.get(data.serverId).renamePath(data.from, data.to);
    }

    // ---- Docker ----------------------------------------------------------------------

    async handleDockerList(data: { serverId: string }): Promise<DockerState> {
        return dockerList(this.fleet.get(data.serverId));
    }

    async handleDockerContainerAction(data: { serverId: string; containerId: string; action: ContainerAction }): Promise<void> {
        await dockerContainerAction(this.fleet.get(data.serverId), data.containerId, data.action);
    }

    async handleDockerContainerLogs(data: { serverId: string; containerId: string; tail?: number }): Promise<{ logs: string }> {
        return { logs: await dockerContainerLogs(this.fleet.get(data.serverId), data.containerId, data.tail ?? 500) };
    }

    async handleDockerOverview(data: { serverId: string }): Promise<DockerOverview> {
        return dockerOverview(this.fleet.get(data.serverId));
    }

    async handleDockerStacks(data: { serverId: string }): Promise<DockerStacksState> {
        return dockerStacks(this.fleet.get(data.serverId));
    }

    async handleDockerStackAction(data: { serverId: string; project: string; action: StackAction }): Promise<void> {
        await dockerStackAction(this.fleet.get(data.serverId), data.project, data.action);
    }

    async handleDockerContainerInspect(data: { serverId: string; containerId: string }): Promise<DockerContainerDetail> {
        return dockerContainerInspect(this.fleet.get(data.serverId), data.containerId);
    }

    async handleDockerVolumeInspect(data: { serverId: string; name: string }): Promise<DockerVolumeDetail> {
        return dockerVolumeInspect(this.fleet.get(data.serverId), data.name);
    }

    async handleDockerVolumeRemove(data: { serverId: string; name: string }): Promise<void> {
        await dockerVolumeRemove(this.fleet.get(data.serverId), data.name);
    }

    async handleDockerImageAction(data: { serverId: string; imageId: string; action: ImageAction }): Promise<void> {
        await dockerImageAction(this.fleet.get(data.serverId), data.imageId, data.action);
    }

    async handleDockerImagePull(data: { serverId: string; ref: string }): Promise<{ ok: boolean; message: string }> {
        return dockerImagePull(this.fleet.get(data.serverId), data.ref);
    }

    // ---- Node enrollment ---------------------------------------------------------------

    async handleGenerateNodeInstallCommand(data: { platform: "linux" | "mac" | "windows"; useExternal?: boolean }): Promise<{ command: string; expiresAt: number; externalHost: string | null }> {
        if (!this.nodeServer) {
            throw new Error("Node server not initialized");
        }
        const config = await readConfig();
        return this.nodeServer.generateInstallCommand(data.platform, config.domain ?? null, data.useExternal ?? false);
    }

    async handleProbeInstallPath(data: { serverId: string; path: string }): Promise<InstallProbeResult> {
        return this.fleet.get(data.serverId).probeInstallPath(data.path);
    }

    async handleInstallNodeService(data: { serverId: string; installDir: string | null; dataDir: string | null; mechanism: InstallMechanism }): Promise<{ startCommand: string | null }> {
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

    async handleUpdateNodeService(data: { serverId: string }): Promise<void> {
        const agent = this.fleet.get(data.serverId);
        const current = agent.status().info?.agentVersion;
        console.log(`[update] updateNodeService for ${data.serverId}: ${current ?? "?"} -> ${AGENT_VERSION} (state ${agent.status().state}, mode ${agent.mode})`);
        if (agent.status().state !== "online") {
            throw new Error("Agent is not connected");
        }
        if (agent.mode !== "installed") {
            throw new Error("Only installed agents can be updated");
        }
        if (current === AGENT_VERSION) {
            throw new Error("Agent is already up to date");
        }
        await agent.updateService(AGENT_VERSION);
        console.log(`[update] ${data.serverId} acknowledged update to ${AGENT_VERSION}`);
    }

    async handleGetControlPlaneStatus(): Promise<{ version: string; installed: boolean; latestVersion: string | null; updateAvailable: boolean }> {
        return controlPlaneStatus();
    }

    async handleUpdateControlPlane(): Promise<void> {
        console.log(`[update] control-plane self-update requested (current ${AGENT_VERSION})`);
        await updateControlPlane();
    }

    // ---- Config ------------------------------------------------------------------------

    async handleGetConfig(): Promise<{ domain: string | null }> {
        const config = await readConfig();
        return { domain: config.domain ?? null };
    }

    async handleSetDomain(data: { domain: string | null }): Promise<void> {
        await persistSetDomain(data.domain);
        // Re-issue the leaf so it carries the new domain in its SAN; agents trust the
        // CA, so this takes effect without re-enrolling anything.
        await this.nodeServer?.refreshTls();
    }

    // ---- Processes ---------------------------------------------------------------------

    async handleGetProcesses(data: { serverId: string }): Promise<ProcessInfo[]> {
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

    async handleGetNetworkInfo(data: { serverId: string }): Promise<NetworkInfo> {
        return getNetworkInfo(this.fleet.get(data.serverId));
    }

    // ---- Systemd -----------------------------------------------------------------------

    async handleSystemdList(data: { serverId: string }): Promise<SystemdState> {
        return systemdList(this.fleet.get(data.serverId));
    }

    async handleSystemdServiceAction(data: { serverId: string; unit: string; action: ServiceAction }): Promise<void> {
        await systemdServiceAction(this.fleet.get(data.serverId), data.unit, data.action);
    }

    async handleSystemdServiceLogs(data: { serverId: string; unit: string; lines?: number }): Promise<{ logs: string }> {
        return { logs: await systemdServiceLogs(this.fleet.get(data.serverId), data.unit, data.lines ?? 300) };
    }

    async handleSystemdUnitFile(data: { serverId: string; unit: string }): Promise<{ content: string }> {
        return { content: await systemdUnitFile(this.fleet.get(data.serverId), data.unit) };
    }
}
