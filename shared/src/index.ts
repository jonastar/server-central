export * from "./node-protocol";
export * from "./metrics";

// ---- Protocol plumbing -------------------------------------------------------
//
// The API is a map of typed operations. Each operation is exposed as
// `POST /<operationName>` with a JSON body of `data` and a JSON response of
// `response`. Live state is pushed over a WebSocket at `/events` as `ApiEvent`s.

export type ProtocolSchema = {
    [key: string]: { data: unknown; response: unknown };
};

export type ApiHandler<T extends ProtocolSchema> = {
    [K in keyof T]: (data: T[K]["data"]) => Promise<T[K]["response"]>;
};

// ---- Servers -----------------------------------------------------------------
//
// Each managed host runs an agent. For now the only agent lives in the same
// process as the web backend ("local"); remote agents come later and will
// implement the same surface.

export type ServerConnState = "connecting" | "online" | "offline" | "error";

/**
 * How an agent is running on its host:
 * - `live`: an ephemeral connection started by pasting the install command.
 * - `installed`: a permanent agent (e.g. a systemd service). Takes priority
 *   over a `live` agent for the same machine.
 */
export type AgentMode = "live" | "installed";

/**
 * Version of the agent software (server + node ship together from this
 * monorepo, so a single constant covers both the embedded and remote agents).
 */
export const AGENT_VERSION = "0.1.0";

/**
 * Fixed TLS server name the control-plane cert is issued for. The agent pins the
 * exact cert via `ca`, so the hostname is not the trust anchor — but Bun (unlike
 * Node) enforces hostname↔SAN verification at the TLS layer and ignores
 * `checkServerIdentity`. Using a constant name (present in the cert SAN, sent as
 * the client `servername`) makes verification succeed regardless of whether the
 * agent connects by IP or domain.
 */
export const CONTROL_PLANE_TLS_SERVERNAME = "control-plane";

export interface SystemInfo {
    hostname: string;
    os: string;
    kernel: string;
    arch: string;
    primaryIp: string;
    cpuModel: string;
    cpuCores: number;
    /** Uptime at `capturedAt`; add elapsed wall time for a live value. */
    uptimeSeconds: number;
    capturedAt: number;
    /** Agent software version; absent for records written before versions existed. */
    agentVersion?: string;
}

/** A connected-but-not-active agent for a machine (a duplicate/lower-priority connection). */
export interface StandbyAgent {
    name: string;
    mode: AgentMode;
    agentVersion?: string;
}

export interface ServerStatus {
    serverId: string;
    state: ServerConnState;
    error?: string;
    info?: SystemInfo;
    /** How the agent is running on this host; absent for never-connected hosts. */
    mode?: AgentMode;
    /** When the agent was last seen, for offline entries. Absent while online. */
    lastSeenAt?: number;
    /** Other connections to this machine that lost the priority race (live vs installed). */
    standbys?: StandbyAgent[];
}

export interface ServerEntry {
    id: string;
    name: string;
    status: ServerStatus;
}

// ---- Metrics -----------------------------------------------------------------

export interface DiskUsage {
    filesystem: string;
    mount: string;
    totalKb: number;
    usedKb: number;
}

export interface MetricsSnapshot {
    ts: number;
    cpu: {
        /** 0..100 */
        total: number;
        /** 0..100 per core */
        perCore: number[];
    };
    memory: {
        totalKb: number;
        usedKb: number;
        availableKb: number;
        swapTotalKb: number;
        swapUsedKb: number;
    };
    network: {
        rxBytesPerSec: number;
        txBytesPerSec: number;
    };
    diskIo: {
        readBytesPerSec: number;
        writeBytesPerSec: number;
    };
    disks: DiskUsage[];
}

// ---- Files -------------------------------------------------------------------

export type DirEntryType = "file" | "dir" | "symlink" | "other";

export interface DirEntry {
    name: string;
    type: DirEntryType;
    sizeBytes: number;
    /** ms epoch */
    modifiedAt: number;
    /** e.g. "rwxr-xr-x" */
    permissions: string;
}

export interface FileContent {
    path: string;
    content: string;
    sizeBytes: number;
    truncated: boolean;
    /** True when the file looks binary; content will be empty. */
    binary: boolean;
}

// ---- Docker ------------------------------------------------------------------

export interface ContainerInfo {
    id: string;
    name: string;
    image: string;
    /** running | exited | paused | created | restarting | dead */
    state: string;
    /** Human status, e.g. "Up 3 days" */
    status: string;
    ports: string;
    createdAt: string;
}

export interface DockerVolumeInfo {
    name: string;
    driver: string;
    mountpoint: string;
}

export interface DockerImageInfo {
    id: string;
    repository: string;
    tag: string;
    size: string;
    createdSince: string;
}

export interface DockerState {
    available: boolean;
    error?: string;
    containers: ContainerInfo[];
    volumes: DockerVolumeInfo[];
    images: DockerImageInfo[];
}

export type ContainerAction = "start" | "stop" | "restart" | "remove";

// ---- Processes ---------------------------------------------------------------

export interface ProcessInfo {
    pid: number;
    user: string;
    cpuPct: number;
    memPct: number;
    rssKb: number;
    started: string;
    command: string;
}

// ---- Auth & users ------------------------------------------------------------
//
// Roles are coarse (v1). `owner` is the first account created during first-run
// setup and can never be deleted. Per-operation enforcement is layered on later;
// for now every authenticated user is the owner.

export type Role = "owner" | "admin" | "operator" | "viewer";

export interface UserInfo {
    id: string;
    username: string;
    role: Role;
    createdAt: number;
}

// ---- HTTP API operations -------------------------------------------------------

export type CentralApiOperations = {
    // Auth (getAuthState/setupOwner/login require no session; the rest do)
    getAuthState: { data: void; response: { needsSetup: boolean; user: UserInfo | null } };
    setupOwner: { data: { username: string; password: string }; response: { token: string; user: UserInfo } };
    login: { data: { username: string; password: string }; response: { token: string; user: UserInfo } };
    logout: { data: void; response: void };
    me: { data: void; response: UserInfo };

    // Servers
    getServers: { data: void; response: ServerEntry[] };

    // Metrics
    getMetricsHistory: { data: { serverId: string }; response: MetricsSnapshot[] };

    // Files
    listDir: { data: { serverId: string; path: string }; response: { path: string; entries: DirEntry[] } };
    readFile: { data: { serverId: string; path: string }; response: FileContent };
    writeFile: { data: { serverId: string; path: string; content: string }; response: void };
    createDir: { data: { serverId: string; path: string }; response: void };
    deletePath: { data: { serverId: string; path: string }; response: void };
    renamePath: { data: { serverId: string; from: string; to: string }; response: void };

    // Docker
    dockerList: { data: { serverId: string }; response: DockerState };
    dockerContainerAction: { data: { serverId: string; containerId: string; action: ContainerAction }; response: void };
    dockerContainerLogs: { data: { serverId: string; containerId: string; tail?: number }; response: { logs: string } };

    // Processes
    getProcesses: { data: { serverId: string }; response: ProcessInfo[] };

    // Node enrollment
    generateNodeInstallCommand: {
        data: { platform: "linux" | "mac" | "windows" };
        response: { command: string; expiresAt: number };
    };

    // Promote a connected live agent to a permanent systemd service.
    installNodeService: { data: { serverId: string }; response: void };

    // Update an installed agent to the control plane's current AGENT_VERSION.
    updateNodeService: { data: { serverId: string }; response: void };

    // Config
    getConfig: { data: void; response: { domain: string | null } };
    setDomain: { data: { domain: string | null }; response: void };
};

// ---- WebSocket events ----------------------------------------------------------

export type ApiEvent =
    | { kind: "init"; data: { servers: ServerEntry[]; metricsHistory: Record<string, MetricsSnapshot[]> } }
    | { kind: "serversUpdate"; data: ServerEntry[] }
    | { kind: "statusUpdate"; data: ServerStatus }
    | { kind: "metrics"; data: { serverId: string; snapshot: MetricsSnapshot } };

// ---- Terminal protocol (WebSocket at /terminal?serverId=...) --------------------

export type TerminalClientMessage =
    | { type: "input"; data: string }
    | { type: "resize"; cols: number; rows: number };

export type TerminalServerMessage =
    | { type: "data"; data: string }
    | { type: "exit"; code: number | null }
    | { type: "error"; message: string };
