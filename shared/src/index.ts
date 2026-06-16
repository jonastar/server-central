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
}

export interface ServerStatus {
    serverId: string;
    state: ServerConnState;
    error?: string;
    info?: SystemInfo;
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

// ---- HTTP API operations -------------------------------------------------------

export type CentralApiOperations = {
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
