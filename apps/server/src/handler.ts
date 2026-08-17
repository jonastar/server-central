import type {
    ApiHandlerPrefixed,
    App,
    AppDetection,
    AppStatus,
    AssignableRole,
    CentralApiOperations,
    DirEntry,
    DockerContainerDetail,
    DockerOverview,
    DockerStacksState,
    DockerState,
    DockerVolumeDetail,
    FileContent,
    ImageAction,
    ImageDefaults,
    InstallMechanism,
    InstallProbeResult,
    MetricsSnapshot,
    NetworkInfo,
    OidcAuthorizeParams,
    OidcClient,
    ProcessInfo,
    ProxyApplyResult,
    ProxyConfig,
    ProxyRoute,
    ProxyState,
    ServerEntry,
    SystemdState,
    SystemUserHostStatus,
    SystemUsersState,
    TaskLogLine,
    TaskRun,
    TaskSpec,
    UserDetail,
    UserInfo,
    MountsState,
    ZfsBlockDevice,
    ZfsDataset,
    ZfsSnapshot,
    ZfsState,
} from "@central/shared";
import { AGENT_VERSION } from "@central/shared";
import {
    dockerContainerInspect,
    dockerContainerLogs,
    dockerImageAction,
    dockerList,
    dockerOverview,
    dockerStacks,
    dockerVolumeInspect,
    dockerVolumeRemove,
    getAppLogs,
    getAppStatus,
    imageDefaults,
    validateComposeContent,
} from "./docker";
import { getMounts } from "./host-mounts";
import { getNetworkInfo } from "./network";
import { systemdList, systemdServiceLogs, systemdUnitFile } from "./systemd";
import { systemUserCreate, systemUserLookup, systemUserSetGroups, systemUsersList } from "./system-users";
import { setDatasetProperty, zfsGetBlockDevices, zfsGetDatasets, zfsGetSnapshots, zfsGetState } from "./zfs";
import type { AppStore } from "./apps";
import type { AuthContext, AuthStore } from "./auth";
import type { Fleet } from "./fleet";
import type { NodeServer } from "./node-server";
import type { OidcStore } from "./oidc/store";
import type { ProxyManager } from "./proxy/manager";
import type { TaskRunner } from "./tasks/runner";
import type { TaskStore } from "./tasks/store";
import { readConfig, setDomain as persistSetDomain, setIssuerUrl as persistSetIssuerUrl } from "./config";
import { controlPlaneStatus, updateControlPlane } from "./server-install";

/** Throws unless the caller is the owner. Used to gate Users/OIDC-client admin
 *  ops — the only place role enforcement exists today (see Role's doc comment
 *  in @central/shared for the broader per-operation RBAC that's still pending). */
function requireOwner(ctx?: AuthContext): void {
    if (ctx?.user?.role !== "owner") {
        throw new Error("Only the owner can do this");
    }
}

/** ZFS pool/vdev topology mutations — the highest blast-radius task kinds —
 *  are owner-only (see doc/idea_zfs.md's safety model). Dataset/snapshot
 *  mutations aren't gated, consistent with the rest of the task system today
 *  (docker/systemd actions aren't role-gated either — see requireOwner's
 *  comment on the state of per-op RBAC). */
const ZFS_OWNER_ONLY_TASK_KINDS = new Set<TaskSpec["kind"]>([
    "zfs_pool_create",
    "zfs_pool_destroy",
    "zfs_pool_import",
    "zfs_pool_export",
    "zfs_vdev_add",
    "zfs_device_replace",
]);

export class CentralHandler implements ApiHandlerPrefixed<CentralApiOperations> {
    constructor(
        private readonly fleet: Fleet,
        private readonly auth: AuthStore,
        private readonly nodeServer: NodeServer | null = null,
        private readonly tasks: TaskRunner,
        private readonly taskStore: TaskStore,
        private readonly oidc: OidcStore,
        private readonly proxy: ProxyManager,
        private readonly apps: AppStore,
    ) { }

    // ---- Auth -----------------------------------------------------------------

    async handleGetAuthState(_data: void, ctx?: AuthContext): Promise<{ needsSetup: boolean; user: UserInfo | null }> {
        return { needsSetup: this.auth.needsSetup(), user: ctx?.user ?? null };
    }

    async handleSetupOwner(data: { username: string; password: string }, ctx?: AuthContext): Promise<{ token: string; user: UserInfo }> {
        return this.auth.setupOwner(data.username, data.password, ctx?.ip ?? null, ctx?.userAgent ?? null);
    }

    async handleLogin(data: { username: string; password: string }, ctx?: AuthContext): Promise<{ token: string; user: UserInfo }> {
        return this.auth.login(data.username, data.password, ctx?.ip ?? null, ctx?.userAgent ?? null);
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

    // ---- Users (owner-only) ----------------------------------------------------

    async handleListUsers(_data: void, ctx?: AuthContext): Promise<UserInfo[]> {
        requireOwner(ctx);
        return this.auth.listUsers();
    }

    async handleCreateUser(data: { username: string; password: string; role: AssignableRole }, ctx?: AuthContext): Promise<UserInfo> {
        requireOwner(ctx);
        return this.auth.addUser(data.username, data.password, data.role);
    }

    async handleDeleteUser(data: { userId: string }, ctx?: AuthContext): Promise<void> {
        requireOwner(ctx);
        await this.auth.deleteUser(data.userId, ctx!.user!.id);
    }

    async handleUpdateUserRole(data: { userId: string; role: AssignableRole }, ctx?: AuthContext): Promise<void> {
        requireOwner(ctx);
        await this.auth.updateUserRole(data.userId, data.role);
    }

    async handleGetUserDetail(data: { userId: string }, ctx?: AuthContext): Promise<UserDetail> {
        requireOwner(ctx);
        return this.auth.getUserDetail(data.userId, ctx!.token);
    }

    async handleRevokeUserSession(data: { userId: string; sessionId: string }, ctx?: AuthContext): Promise<void> {
        requireOwner(ctx);
        await this.auth.revokeSession(data.userId, data.sessionId, ctx!.token);
    }

    async handleAdminSetPassword(data: { userId: string; password: string }, ctx?: AuthContext): Promise<void> {
        requireOwner(ctx);
        await this.auth.adminSetPassword(data.userId, data.password);
    }

    async handleSetUserSystemUser(data: { userId: string; systemUser: string | null }, ctx?: AuthContext): Promise<void> {
        requireOwner(ctx);
        await this.auth.setSystemUser(data.userId, data.systemUser);
    }

    // ---- OIDC clients (owner-only admin) -----------------------------------------
    //
    // An OIDC client is a relying-party registration (id/secret + redirect URIs)
    // for Central's built-in OIDC provider — unrelated to the App entity (compose
    // stacks on a host) below the reverse-proxy block.

    async handleListOidcClients(_data: void, ctx?: AuthContext): Promise<OidcClient[]> {
        requireOwner(ctx);
        return this.oidc.listClients();
    }

    async handleCreateOidcClient(data: { name: string; redirectUris: string[] }, ctx?: AuthContext): Promise<{ client: OidcClient; clientSecret: string }> {
        requireOwner(ctx);
        const config = await readConfig();
        if (!config.issuerUrl) {
            throw new Error("Set an Issuer URL in Settings before registering OIDC clients");
        }
        return this.oidc.createClient(data.name, data.redirectUris);
    }

    async handleDeleteOidcClient(data: { clientId: string }, ctx?: AuthContext): Promise<void> {
        requireOwner(ctx);
        await this.oidc.deleteClient(data.clientId);
    }

    // ---- Apps (directory + compose stack on a host) ------------------------------
    //
    // See doc/idea_app_system.md. Not role-gated beyond "any authenticated user",
    // same as every other non-owner-gated endpoint (requireOwner's comment above).

    async handleListApps(): Promise<App[]> {
        return this.apps.list();
    }

    async handleCreateApp(data: { name: string; hostId: string; dir: string }): Promise<App> {
        return this.apps.create(data.name, data.hostId, data.dir);
    }

    async handleDetectApp(data: { hostId: string; dir: string }): Promise<AppDetection> {
        return this.apps.detect(data.hostId, data.dir);
    }

    async handleImportApp(data: { hostId: string; dir: string; name: string }): Promise<App> {
        return this.apps.import(data.hostId, data.dir, data.name);
    }

    async handleDeleteApp(data: { appId: string; deleteDir: boolean }): Promise<void> {
        await this.apps.delete(data.appId, data.deleteDir);
    }

    async handleGetAppStatus(data: { appId: string }): Promise<AppStatus> {
        const app = this.apps.get(data.appId);
        return getAppStatus(this.fleet.get(app.hostId), app.dir, app.composeFile, app.project);
    }

    async handleGetAppLogs(data: { appId: string; service?: string; tail?: number }): Promise<{ logs: string }> {
        const app = this.apps.get(data.appId);
        const logs = await getAppLogs(this.fleet.get(app.hostId), app.dir, app.composeFile, app.project, data.service, data.tail ?? 500);
        return { logs };
    }

    async handleValidateComposeContent(data: { appId: string; content: string }): Promise<{ valid: true } | { valid: false; error: string }> {
        const app = this.apps.get(data.appId);
        return validateComposeContent(this.fleet.get(app.hostId), app.dir, app.project, data.content);
    }

    // ---- Reverse proxy (owner-only) ----------------------------------------------
    //
    // SC-managed Caddy on one designated node. See doc/idea_reverse_proxy.md and
    // the ProxyManager for the deploy/apply mechanics.

    async handleGetProxyState(_data: void, ctx?: AuthContext): Promise<ProxyState> {
        requireOwner(ctx);
        return this.proxy.state();
    }

    async handleSetProxyConfig(data: { config: ProxyConfig | null }, ctx?: AuthContext): Promise<void> {
        requireOwner(ctx);
        await this.proxy.setConfig(data.config);
    }

    async handleDeployProxy(_data: void, ctx?: AuthContext): Promise<void> {
        requireOwner(ctx);
        await this.proxy.deploy();
    }

    async handleRemoveProxy(_data: void, ctx?: AuthContext): Promise<void> {
        requireOwner(ctx);
        await this.proxy.remove();
    }

    async handleCreateProxyRoute(data: { route: Omit<ProxyRoute, "id"> }, ctx?: AuthContext): Promise<ProxyRoute> {
        requireOwner(ctx);
        return this.proxy.createRoute(data.route);
    }

    async handleUpdateProxyRoute(data: { route: ProxyRoute }, ctx?: AuthContext): Promise<void> {
        requireOwner(ctx);
        await this.proxy.updateRoute(data.route);
    }

    async handleDeleteProxyRoute(data: { routeId: string }, ctx?: AuthContext): Promise<void> {
        requireOwner(ctx);
        await this.proxy.deleteRoute(data.routeId);
    }

    async handleApplyProxyConfig(_data: void, ctx?: AuthContext): Promise<ProxyApplyResult> {
        requireOwner(ctx);
        return this.proxy.apply();
    }

    // ---- OIDC front-channel (authenticated user) -------------------------------
    //
    // Driven by the SPA's /oidc/authorize route: it resolves the request to show
    // "Continue as X to <app>?", then mints the code on confirm. The actual
    // code-for-token exchange is raw HTTP at POST /oidc/token (see index.ts),
    // since that leg is called by the relying party's backend, not the browser.

    async handleGetOidcAuthorizeRequest(data: OidcAuthorizeParams): Promise<{ appName: string; redirectUri: string }> {
        const app = this.oidc.validateRequest(data);
        return { appName: app.name, redirectUri: data.redirectUri };
    }

    async handleCompleteOidcAuthorize(data: OidcAuthorizeParams, ctx?: AuthContext): Promise<{ redirectUrl: string }> {
        if (!ctx?.user) {
            throw new Error("Not authenticated");
        }
        const app = this.oidc.validateRequest(data);
        const code = this.oidc.issueCode({
            userId: ctx.user.id,
            clientId: app.id,
            redirectUri: data.redirectUri,
            scope: data.scope,
            codeChallenge: data.codeChallenge,
            nonce: data.nonce ?? null,
        });
        const url = new URL(data.redirectUri);
        url.searchParams.set("code", code);
        url.searchParams.set("state", data.state);
        return { redirectUrl: url.toString() };
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

    async handleDockerContainerLogs(data: CentralApiOperations["dockerContainerLogs"]["data"]): Promise<{ logs: string }> {
        const { serverId, containerId, ...opts } = data;
        return { logs: await dockerContainerLogs(this.fleet.get(serverId), containerId, opts) };
    }

    async handleDockerOverview(data: { serverId: string }): Promise<DockerOverview> {
        return dockerOverview(this.fleet.get(data.serverId));
    }

    async handleDockerStacks(data: { serverId: string }): Promise<DockerStacksState> {
        return dockerStacks(this.fleet.get(data.serverId));
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

    async handleDockerImageDefaults(data: { serverId: string; image: string }): Promise<ImageDefaults> {
        return imageDefaults(this.fleet.get(data.serverId), data.image);
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

    async handleInstallNodeService(data: { serverId: string; installDir: string | null; dataDir: string | null; mechanism: InstallMechanism; force?: boolean }): Promise<{ startCommand: string | null }> {
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
        const startCommand = await agent.installService(agentToken, installDir, dataDir, data.mechanism, data.force);
        return { startCommand };
    }

    async handleGetControlPlaneStatus(): Promise<{ version: string; installed: boolean; latestVersion: string | null; updateAvailable: boolean }> {
        return controlPlaneStatus();
    }

    async handleUpdateControlPlane(): Promise<void> {
        console.log(`[update] control-plane self-update requested (current ${AGENT_VERSION})`);
        await updateControlPlane();
    }

    // ---- Config ------------------------------------------------------------------------

    async handleGetConfig(): Promise<{ domain: string | null; issuerUrl: string | null }> {
        const config = await readConfig();
        return { domain: config.domain ?? null, issuerUrl: config.issuerUrl ?? null };
    }

    async handleSetDomain(data: { domain: string | null }): Promise<void> {
        await persistSetDomain(data.domain);
        // Re-issue the leaf so it carries the new domain in its SAN; agents trust the
        // CA, so this takes effect without re-enrolling anything.
        await this.nodeServer?.refreshTls();
    }

    async handleSetIssuerUrl(data: { issuerUrl: string | null }): Promise<void> {
        if (data.issuerUrl) {
            try {
                new URL(data.issuerUrl);
            } catch {
                throw new Error("Issuer URL must be a valid absolute URL");
            }
        }
        await persistSetIssuerUrl(data.issuerUrl);
    }

    // ---- Tasks -------------------------------------------------------------------------

    async handleRunTask(data: { spec: TaskSpec; target: string | null }, ctx?: AuthContext): Promise<{ id: string }> {
        if (ZFS_OWNER_ONLY_TASK_KINDS.has(data.spec.kind)) {
            requireOwner(ctx);
        }
        const run = await this.tasks.start(data.spec, data.target, { kind: "manual", userId: ctx?.user?.id });
        return { id: run.id };
    }

    async handleListTasks(data: { target?: string | null; kind?: TaskSpec["kind"]; limit?: number }): Promise<TaskRun[]> {
        return this.taskStore.list(data);
    }

    async handleGetTask(data: { id: string }): Promise<TaskRun | null> {
        return this.taskStore.get(data.id);
    }

    async handleGetTaskLogs(data: { id: string }): Promise<TaskLogLine[]> {
        return this.tasks.getLogs(data.id);
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

    // ---- System users --------------------------------------------------------------------

    async handleSystemUsersList(data: { serverId: string }): Promise<SystemUsersState> {
        return systemUsersList(this.fleet.get(data.serverId), this.auth.listUsers());
    }

    async handleSystemUserCreate(data: { serverId: string; username: string; groups: string[] }, ctx?: AuthContext): Promise<void> {
        requireOwner(ctx);
        await systemUserCreate(this.fleet.get(data.serverId), data.username, data.groups ?? []);
    }

    async handleSystemUserHostStatus(data: { username: string }): Promise<SystemUserHostStatus[]> {
        return Promise.all(this.fleet.entries().map(async (entry): Promise<SystemUserHostStatus> => {
            const base = { serverId: entry.id, serverName: entry.name };
            if (entry.status.state !== "online") {
                return { ...base, status: "offline" };
            }
            try {
                const res = await systemUserLookup(this.fleet.get(entry.id), data.username);
                if (res.error) {
                    return { ...base, status: "error", error: res.error };
                }
                return res.found ? { ...base, status: "exists", user: res.user } : { ...base, status: "missing" };
            } catch (err) {
                return { ...base, status: "error", error: err instanceof Error ? err.message : String(err) };
            }
        }));
    }

    async handleSystemUserSetGroups(data: { serverId: string; username: string; groups: string[] }, ctx?: AuthContext): Promise<void> {
        requireOwner(ctx);
        await systemUserSetGroups(this.fleet.get(data.serverId), data.username, data.groups ?? []);
    }

    // ---- Systemd -----------------------------------------------------------------------

    async handleSystemdList(data: { serverId: string }): Promise<SystemdState> {
        return systemdList(this.fleet.get(data.serverId));
    }

    async handleSystemdServiceLogs(data: CentralApiOperations["systemdServiceLogs"]["data"]): Promise<{ logs: string }> {
        const { serverId, unit, ...opts } = data;
        return { logs: await systemdServiceLogs(this.fleet.get(serverId), unit, opts) };
    }

    async handleSystemdUnitFile(data: { serverId: string; unit: string }): Promise<{ content: string }> {
        return { content: await systemdUnitFile(this.fleet.get(data.serverId), data.unit) };
    }

    // ---- ZFS ---------------------------------------------------------------------------
    //
    // Read-only + low-risk direct ops. Pool/vdev/dataset/snapshot mutations go
    // through runTask instead (see the zfs_* TaskSpec kinds and ZFS_OWNER_ONLY_TASK_KINDS
    // above) — see doc/idea_zfs.md.

    async handleGetZfsState(data: { serverId: string }): Promise<ZfsState> {
        return zfsGetState(this.fleet.get(data.serverId));
    }

    async handleGetZfsDatasets(data: { serverId: string; pool?: string }): Promise<ZfsDataset[]> {
        return zfsGetDatasets(this.fleet.get(data.serverId), data.pool);
    }

    async handleGetZfsSnapshots(data: { serverId: string; dataset?: string }): Promise<ZfsSnapshot[]> {
        return zfsGetSnapshots(this.fleet.get(data.serverId), data.dataset);
    }

    async handleGetZfsBlockDevices(data: { serverId: string }): Promise<ZfsBlockDevice[]> {
        return zfsGetBlockDevices(this.fleet.get(data.serverId));
    }

    async handleSetDatasetProperty(data: { serverId: string; name: string; key: string; value: string }): Promise<void> {
        await setDatasetProperty(this.fleet.get(data.serverId), data.name, data.key, data.value);
    }

    // ---- Mounts ------------------------------------------------------------------------

    async handleGetMounts(data: { serverId: string }): Promise<MountsState> {
        return getMounts(this.fleet.get(data.serverId));
    }
}
