import pkg from "../package.json" with { type: "json" };

import type { TaskRun, TaskSpec } from "./tasks";

export * from "./node-protocol";
export * from "./metrics";
export * from "./tasks";

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

/**
 * Like {@link ApiHandler}, but every method name is prefixed with `handle`
 * (e.g. `login` → `handleLogin`). The HTTP dispatcher derives the method name
 * from the request path and prefixes it before indexing the handler, so a
 * request can only ever reach a `handle*` method — never an arbitrary property
 * off the object/prototype chain (`constructor`, `toString`, …).
 */
export type ApiHandlerPrefixed<T extends ProtocolSchema> = {
    [K in keyof T as `handle${Capitalize<string & K>}`]: (data: T[K]["data"]) => Promise<T[K]["response"]>;
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
 * - `embedded`: the control plane's own in-process agent for the host it runs
 *   on. Always connected, can't be installed, and outranks live/installed for
 *   that machine.
 */
export type AgentMode = "live" | "installed" | "embedded";

/**
 * Version of the agent software (server + node ship together from this
 * monorepo, so a single constant covers both the embedded and remote agents).
 * Sourced from the shared package's package.json so there's one place to bump it.
 */
export const AGENT_VERSION: string = pkg.version;

/**
 * Common Name (and a baseline SAN entry) of the control-plane leaf cert. Agents
 * trust the CA that signs the leaf, and the leaf's SAN additionally carries the
 * concrete addresses the agent connects to (LAN IP, WAN IP, domain), so Bun's
 * hostname↔SAN verification passes whether the agent connects by IP or by domain.
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
    /** Default install/data locations and whether they're usable as-is. When
     *  `defaultsUsable` is false (e.g. a read-only OS root or noexec mount, as on
     *  TrueNAS) the setup wizard requires custom paths on writable, exec storage. */
    install?: AgentInstallInfo;
}

/** How an installed agent is supervised on its host. */
export type InstallMechanism = "systemd" | "manual";

export interface AgentInstallInfo {
    /** Where the binary would install by default (e.g. /usr/local/bin). */
    defaultInstallDir: string;
    /** Where cert/config/state would live by default (e.g. /var/lib/sc-agent). */
    defaultDataDir: string;
    /** Both defaults are writable and exec-capable — a one-click install will work. */
    defaultsUsable: boolean;
}

/** Result of probing a candidate install/data directory on an agent's host. */
export interface InstallProbeResult {
    /** The directory already exists. */
    exists: boolean;
    /** The directory is writable (created if missing during the probe). */
    writable: boolean;
    /** A binary can be executed from the directory (not a noexec mount). */
    execCapable: boolean;
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
    /** Source IP of the agent's connection as seen by the control plane (its public
     *  IP when across NAT). Null for the embedded host and never-connected entries. */
    remoteIp?: string | null;
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
    /** Text (utf8) or, for images, the base64-encoded bytes (see `encoding`). */
    content: string;
    sizeBytes: number;
    truncated: boolean;
    /** True when the file looks binary; content will be empty unless it's an image. */
    binary: boolean;
    /** How `content` is encoded. Absent means plain utf8 text. */
    encoding?: "base64";
    /** MIME type for renderable files (currently images), e.g. "image/png". */
    mimeType?: string;
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
    /** Compose project (com.docker.compose.project label), if any. */
    project?: string;
    /** Compose service (com.docker.compose.service label), if any. */
    service?: string;
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

export type ContainerAction = "start" | "stop" | "restart" | "remove" | "pause" | "unpause";

/** A compose stack derived from container labels. */
export interface DockerStack {
    project: string;
    /** Total containers belonging to the stack. */
    containers: number;
    /** Containers currently running. */
    running: number;
    /** com.docker.compose.project.config_files label, if present. */
    configFiles: string;
    /** Distinct container states present in the stack. */
    states: string[];
}

export interface DockerStacksState {
    available: boolean;
    error?: string;
    stacks: DockerStack[];
}

export interface DockerMount {
    type: string;
    source: string;
    destination: string;
}

/** `docker inspect` of a single container, distilled for the detail view. */
export interface DockerContainerDetail {
    id: string;
    name: string;
    image: string;
    state: string;
    status: string;
    created: string;
    command: string;
    ports: string[];
    mounts: DockerMount[];
    env: string[];
    networks: string[];
    restartPolicy: string;
    /** Pretty-printed raw `docker inspect` JSON. */
    raw: string;
}

export interface DockerVolumeDetail {
    name: string;
    driver: string;
    mountpoint: string;
    /** Containers that mount this volume. */
    attached: { id: string; name: string }[];
    createdAt?: string;
    labels?: string;
}

export interface DockerOverview {
    available: boolean;
    error?: string;
    containersRunning: number;
    containersTotal: number;
    stacks: number;
    volumes: number;
    images: number;
    /** Disk usage from `docker system df`. */
    df?: {
        images: string;
        containers: string;
        volumes: string;
        buildCache: string;
    };
}

export type StackAction = "start" | "stop" | "restart" | "down";
export type ImageAction = "remove";

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

// ---- Networking --------------------------------------------------------------

export interface NetworkAddress {
    /** "inet" (IPv4) or "inet6" (IPv6). */
    family: string;
    address: string;
    prefixlen: number;
    /** e.g. "global", "host", "link". */
    scope: string;
}

export interface NetworkInterface {
    name: string;
    mac: string;
    /** operstate: "UP" | "DOWN" | "UNKNOWN" | … */
    state: string;
    mtu: number;
    addresses: NetworkAddress[];
}

export interface NetworkRoute {
    /** "default" or a CIDR/destination. */
    dst: string;
    gateway?: string;
    dev: string;
    protocol?: string;
    /** prefsrc — the source address used for this route. */
    src?: string;
}

export interface NetworkInfo {
    available: boolean;
    error?: string;
    interfaces: NetworkInterface[];
    routes: NetworkRoute[];
    /** The agent's source IP as seen by the control plane (its public IP across
     *  NAT). Null for the embedded host. */
    remoteIp: string | null;
}

// ---- Systemd -----------------------------------------------------------------

export interface ServiceInfo {
    /** e.g. "ssh.service". */
    unit: string;
    /** loaded | not-found | masked | … */
    load: string;
    /** active | inactive | failed | activating | … */
    active: string;
    /** running | exited | dead | failed | … */
    sub: string;
    description: string;
    /** From unit-files: enabled | disabled | static | masked | … (absent if unknown). */
    enabledState?: string;
}

export interface SystemdState {
    available: boolean;
    error?: string;
    services: ServiceInfo[];
}

export type ServiceAction = "start" | "stop" | "restart" | "enable" | "disable";

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

// ---- Log viewing ---------------------------------------------------------------

/** Display order for log output: oldest line first (classic tail) or newest first. */
export type LogOrder = "oldest" | "newest";
/** Relative time window for log queries. "" means no window (limit only). */
export type LogSince = "" | "15m" | "1h" | "6h" | "24h";
/** Options shared by every log endpoint (docker, journald, …). */
export interface LogQuery {
    /** Max number of lines/entries to return (tail size). */
    limit?: number;
    /** Display order; defaults to "oldest". */
    order?: LogOrder;
    /** Only return entries newer than this window. */
    since?: LogSince;
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
    // Forget a server. Only offline agents can be removed (the embedded host and
    // currently-connected agents are rejected).
    deleteServer: { data: { serverId: string }; response: void };

    // Metrics
    getMetricsHistory: { data: { serverId: string }; response: MetricsSnapshot[] };

    // Files
    listDir: { data: { serverId: string; path: string }; response: { path: string; entries: DirEntry[] } };
    readFile: { data: { serverId: string; path: string }; response: FileContent };
    writeFile: { data: { serverId: string; path: string; content: string }; response: void };
    // Upload raw bytes (base64-encoded) — binary-safe, unlike writeFile's utf8 text.
    uploadFile: { data: { serverId: string; path: string; contentBase64: string }; response: void };
    createDir: { data: { serverId: string; path: string }; response: void };
    deletePath: { data: { serverId: string; path: string }; response: void };
    renamePath: { data: { serverId: string; from: string; to: string }; response: void };

    // Docker
    dockerList: { data: { serverId: string }; response: DockerState };
    dockerContainerAction: { data: { serverId: string; containerId: string; action: ContainerAction }; response: void };
    dockerContainerLogs: { data: { serverId: string; containerId: string; timestamps?: boolean } & LogQuery; response: { logs: string } };
    dockerOverview: { data: { serverId: string }; response: DockerOverview };
    dockerStacks: { data: { serverId: string }; response: DockerStacksState };
    dockerStackAction: { data: { serverId: string; project: string; action: StackAction }; response: void };
    dockerContainerInspect: { data: { serverId: string; containerId: string }; response: DockerContainerDetail };
    dockerVolumeInspect: { data: { serverId: string; name: string }; response: DockerVolumeDetail };
    dockerVolumeRemove: { data: { serverId: string; name: string }; response: void };
    dockerImageAction: { data: { serverId: string; imageId: string; action: ImageAction }; response: void };
    dockerImagePull: { data: { serverId: string; ref: string }; response: { ok: boolean; message: string } };

    // Processes
    getProcesses: { data: { serverId: string }; response: ProcessInfo[] };

    // Networking — adapters, addresses, routes, and the agent's remote IP.
    getNetworkInfo: { data: { serverId: string }; response: NetworkInfo };

    // Systemd — list services, control them, view logs and unit files.
    systemdList: { data: { serverId: string }; response: SystemdState };
    systemdServiceAction: { data: { serverId: string; unit: string; action: ServiceAction }; response: void };
    systemdServiceLogs: { data: { serverId: string; unit: string; priority?: string } & LogQuery; response: { logs: string } };
    systemdUnitFile: { data: { serverId: string; unit: string }; response: { content: string } };

    // Node enrollment
    // useExternal builds the command around the control plane's external host
    // (configured domain, else discovered WAN IP) instead of the LAN IP, for
    // enrolling a machine that isn't on the same network. externalHost in the
    // response is that host (null when none is known) so the UI can offer the
    // toggle only when it would work.
    generateNodeInstallCommand: {
        data: { platform: "linux" | "mac" | "windows"; useExternal?: boolean };
        response: { command: string; expiresAt: number; externalHost: string | null };
    };

    // Promote a connected live agent to a permanent service. installDir/dataDir are
    // where to put the binary and the cert/config/state; null uses the agent defaults
    // (/usr/local/bin, /var/lib/sc-agent). mechanism "systemd" installs a unit;
    // "manual" lays down files and returns a startCommand for the user to wire into
    // their own init system. startCommand is null for the systemd mechanism.
    installNodeService: {
        data: { serverId: string; installDir: string | null; dataDir: string | null; mechanism: InstallMechanism };
        response: { startCommand: string | null };
    };

    // Probe a candidate install/data directory on an agent's host (writable + exec).
    probeInstallPath: { data: { serverId: string; path: string }; response: InstallProbeResult };

    // Update an installed agent to the control plane's current AGENT_VERSION.
    updateNodeService: { data: { serverId: string }; response: void };

    // Control plane (the server itself): its running version vs. the latest release,
    // and a self-update that swaps the binary and restarts. updateAvailable is false
    // unless the control plane is installed as a service and a newer release exists.
    getControlPlaneStatus: {
        data: void;
        response: { version: string; installed: boolean; latestVersion: string | null; updateAvailable: boolean };
    };
    updateControlPlane: { data: void; response: void };

    // Config
    getConfig: { data: void; response: { domain: string | null } };
    setDomain: { data: { domain: string | null }; response: void };

    // Tasks — the uniform envelope (history, typed last-result, run-now).
    // (Logs, cancellation, and schedules are deferred until a task kind needs
    // them; the wire types for those already live in ./tasks.)
    listTasks: { data: { target?: string | null; kind?: TaskSpec["kind"]; limit?: number }; response: TaskRun[] };
    getTask: { data: { id: string }; response: TaskRun | null };
    // Run-now: create + start a run immediately. Returns its id to navigate to.
    runTask: { data: { spec: TaskSpec; target: string | null }; response: { id: string } };
};

// ---- WebSocket events ----------------------------------------------------------

export type ApiEvent =
    | { kind: "init"; data: { servers: ServerEntry[]; metricsHistory: Record<string, MetricsSnapshot[]>; tasks: TaskRun[] } }
    | { kind: "serversUpdate"; data: ServerEntry[] }
    | { kind: "statusUpdate"; data: ServerStatus }
    | { kind: "metrics"; data: { serverId: string; snapshot: MetricsSnapshot } }
    // A run was created or changed status. Carries the full envelope.
    | { kind: "taskUpdate"; data: TaskRun };

// ---- Terminal protocol (WebSocket at /terminal?serverId=...) --------------------

export type TerminalClientMessage =
    | { type: "input"; data: string }
    | { type: "resize"; cols: number; rows: number };

export type TerminalServerMessage =
    | { type: "data"; data: string }
    | { type: "exit"; code: number | null }
    | { type: "error"; message: string };
