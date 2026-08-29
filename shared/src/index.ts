import pkg from "../package.json" with { type: "json" };

import type { TaskLogLine, TaskRun, TaskSpec } from "./tasks";

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

// ---- Features ------------------------------------------------------------------
//
// Identity shared between a server-side Feature and its frontend counterpart. See
// doc/idea_feature_interface.md.

export interface FeatureDescriptor {
    id: string;              // stable key: config storage, dependsOn refs, task-kind
                              // prefixing, and the frontend's matching id. Never
                              // renamed, never shown to the user.
    name: string;
    description: string;
    experimental: boolean;
    dependsOn?: string[];     // other features' ids — inert metadata for now
    /** Host capability this feature needs to be usable on a given host. The
     *  feature still loads (it's per-host, not per-deployment); what changes is
     *  that the UI greys it out for hosts whose agent reported it unavailable. */
    requiresHostCapability?: HostCapability;
}

// ---- Host capabilities -----------------------------------------------------------
//
// Probeable facts about a *managed host* — "is this subsystem actually usable
// here". Distinct from the two other things this codebase calls capabilities:
// AGENT_CAPABILITIES (which protocol message kinds an agent build understands, a
// function of agent version) and the planned RBAC capabilities (what a user may
// do). These are a function of the machine, and can change while the agent runs.
//
// Answered by the agent natively — filesystem and /proc checks, not shelling out
// — so "installed" is distinguished from "actually usable" (a zfs binary with no
// kernel module, a docker socket the agent can't open). Reported unprompted at
// identify and re-runnable on demand; see agent/host-capabilities.ts.

/** Ids are protocol surface: features declare one, agents implement one. */
export type HostCapability = "zfs" | "systemd" | "docker";

export const HOST_CAPABILITIES: readonly HostCapability[] = ["zfs", "systemd", "docker"];

export interface HostCapabilityResult {
    available: boolean;
    /** Why it's unavailable (or a note when it is) — surfaced verbatim in the UI,
     *  so it should name the thing to install or fix. */
    detail?: string;
}

/**
 * Every probe an agent answered, keyed by id.
 *
 * A capability *absent* from the map is **unknown**, not unavailable — the agent
 * predates that probe, or hasn't reported yet. Unknown must render as normally
 * available: an offline or older host has undetermined capabilities, and treating
 * that as "no" would grey out every tab on each reconnect.
 */
export type HostCapabilityReport = Partial<Record<HostCapability, HostCapabilityResult>>;

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
 * Sourced from the shared package's package.json so there's one place to bump it —
 * see scripts/release.ts. A pending version always carries its own "-dev" suffix
 * (e.g. "0.9.0-dev"); a cut release is a plain "x.y.z".
 */
export const AGENT_VERSION: string = pkg.version;

/**
 * Control-message kinds this agent build supports beyond the v0.6.0 baseline,
 * advertised in `identify`. Agents ignore unknown message types, so without
 * this a request to an older agent dies as a silent 30s protocol timeout —
 * the control plane checks the advertised set and fails fast with a real
 * error instead. Add an entry whenever a new request kind joins the protocol —
 * and whenever a new *field* on an existing kind is one an older agent ignoring
 * it would silently do the wrong thing about, rather than merely less of it
 * ("shellAsUser": an agent that drops `openShell.asUser` opens a root shell).
 */
export const AGENT_CAPABILITIES: readonly string[] = ["httpRequest", "stun", "heartbeat", "hostCapabilities", "execStream", "shellAsUser"];

/**
 * Common Name (and a baseline SAN entry) of the control-plane leaf cert. Agents
 * trust the CA that signs the leaf, and the leaf's SAN additionally carries the
 * concrete addresses the agent connects to (LAN IP, WAN IP, domain), so Bun's
 * hostname↔SAN verification passes whether the agent connects by IP or by domain.
 */
export const CONTROL_PLANE_TLS_SERVERNAME = "control-plane";

/**
 * Path prefix every JSON-RPC command and websocket channel on the web/API port
 * lives under (`POST /api/getAuthState`, `WS /api/events`). Prefixed rather than
 * sitting at the root so the surface is separable from the SPA's own routes: a
 * reverse proxy can forward it by prefix, and the Vite dev server proxies exactly
 * this one path back to the control plane instead of guessing which root paths
 * are the API's and which are the app's.
 *
 * The OIDC routes are deliberately *not* under here — `/.well-known/*` and
 * `/oidc/*` are fixed by spec relative to the issuer root.
 */
export const API_PREFIX = "/api";

/**
 * How many metrics snapshots to keep in memory per host (agent-side history and the
 * control plane's `HostAgent.history` both trim to this). At the 5s metrics interval,
 * 720 samples is an hour.
 */
export const METRICS_HISTORY_MAX = 720;

/**
 * Cap on a single `uploadFile` body, enforced by the agent. Shared so the web client
 * can reject an oversized file before spending time base64-encoding and transferring
 * it, instead of only finding out from the agent's rejection after the fact. The
 * control plane's HTTP `maxRequestBodySize` (`apps/server/src/index.ts`) is sized off
 * this constant (base64 is ~4/3 the raw size) — bump both together.
 */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

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
    /** What this host can actually do, as probed by its agent. Absent for
     *  never-connected hosts and agents too old to report — see
     *  {@link HostCapabilityReport} on why that means "unknown", not "no". */
    hostCapabilities?: HostCapabilityReport;
    /** When those probes last ran on the host. */
    hostCapabilitiesAt?: number;
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

/** How a device node is likely to be used, so the picker can group and explain
 *  the list instead of showing bare paths. Derived from the path alone — nothing
 *  here opens the device to ask it what it is. */
export type HostDeviceKind = "serial" | "gpu" | "video" | "tun" | "other";

/** A device node on a host that could be mapped into a container (compose's
 *  `devices:`). Produced by scanning a fixed set of `/dev` locations — see
 *  `features/files/host-devices.ts`; it is not a full `/dev` listing. */
export interface HostDevice {
    /** The path to map. The stable `/dev/serial/by-id/...` symlink when the
     *  device has one — USB serial nodes get renumbered across reboots and
     *  re-plugs, so the raw `/dev/ttyACM0` is the wrong thing to write into a
     *  compose file when a by-id name exists. */
    path: string;
    /** The device node `path` ultimately points at, e.g. `/dev/ttyACM0`. Equal
     *  to `path` when it isn't reached through a symlink. */
    node: string;
    kind: HostDeviceKind;
    /** Other paths reaching the same node — the raw node behind a by-id symlink,
     *  or a second by-id alias for a multi-interface adapter. */
    aliases: string[];
    /** Human name recovered from the by-id filename (e.g. "dresden elektronik
     *  ingenieurtechnik GmbH ConBee II DE2667394"), absent when there's no such
     *  name to read one from. */
    label?: string;
}

export interface HostDevices {
    devices: HostDevice[];
    /** Set when the scan itself failed; `devices` is empty then. An empty list
     *  with no error means the host genuinely has none of the scanned nodes. */
    error?: string;
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

/** What an image's Dockerfile already declares (`VOLUME`/`EXPOSE`/`ENV`) — a
 *  cheap `docker image inspect` away, no pull/run needed. Powers the Compose
 *  visual editor's "suggested volumes/ports/environment" pickers. Only
 *  populated if the image is already present locally; all empty otherwise —
 *  `present` is what tells the two cases apart, so the editor can offer a pull
 *  instead of silently showing no suggestions. */
export interface ImageDefaults {
    /** Whether the image is pulled on the host. False means the three lists are
     *  empty because nothing could be inspected, not because the image declares
     *  nothing. */
    present: boolean;
    volumes: string[];
    ports: { port: number; protocol: "tcp" | "udp" }[];
    env: { key: string; value: string }[];
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
    /** Container labels (`Config.Labels`), as key/value pairs, sorted by key. */
    labels: { key: string; value: string }[];
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

/** Result of a one-shot `docker exec`/`docker compose exec` command (the quick
 *  exec box on the container/app pages) — same shape as the agent's internal
 *  `ExecResult`, not a full interactive session. */
export interface DockerExecResult {
    stdout: string;
    stderr: string;
    code: number;
}

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

// ---- System users --------------------------------------------------------------
//
// Real OS accounts on a managed host (from `getent passwd`), listed in the
// per-server Users tab. Server Central users can be mapped to one of these
// (`UserInfo.systemUser`); their terminal then runs as that account instead of
// the agent's own user (root). See resolveShellUser in apps/server for the policy.

export interface SystemUserInfo {
    username: string;
    uid: number;
    gid: number;
    home: string;
    shell: string;
    /** Primary group first (when resolvable), then supplementary groups. */
    groups: string[];
    /** Name of the primary group (gid), when it resolves to one. Lets the UI
     *  edit supplementary groups without guessing which entry is the primary. */
    primaryGroup: string | null;
    /** Server Central usernames mapped to this account. */
    mappedBy: string[];
}

export interface SystemUsersState {
    available: boolean;
    error?: string;
    users: SystemUserInfo[];
}

/** Presence of a mapped OS account on one host, for the per-user mapped-hosts
 *  view in Settings → Users. */
export interface SystemUserHostStatus {
    serverId: string;
    serverName: string;
    /** offline = host not connected; error = the lookup itself failed. */
    status: "exists" | "missing" | "offline" | "error";
    error?: string;
    /** Account details when status is "exists". */
    user?: Omit<SystemUserInfo, "mappedBy">;
}

// ---- Auth & users ------------------------------------------------------------
//
// Roles are coarse (v1). `owner` is the first account created during first-run
// setup, is a singleton, and can never be deleted or reassigned. The owner can
// create/delete other accounts and assign them admin/operator/viewer, but
// per-operation enforcement of those roles is layered on later — for now every
// authenticated user can do everything the owner can.

export type Role = "owner" | "admin" | "operator" | "viewer";
/** Roles assignable to non-owner accounts; `owner` is fixed at first-run setup. */
export type AssignableRole = Exclude<Role, "owner">;

export interface UserInfo {
    id: string;
    username: string;
    role: Role;
    createdAt: number;
    /** OS account this user's terminal runs as on managed hosts. Null means
     *  unmapped: owner/admin fall back to the agent's own user (root), while
     *  operator/viewer are denied a terminal entirely. */
    systemUser: string | null;
}

/** A single active login session for a user, surfaced on the admin user-detail view. */
export interface UserSession {
    id: string;
    createdAt: number;
    lastSeenAt: number;
    ip: string | null;
    userAgent: string | null;
    /** True when this is the session the requesting admin is themselves using. */
    current: boolean;
}

/** Expanded view of a user shown when an admin drills into a row in the Users tab. */
export interface UserDetail extends UserInfo {
    sessions: UserSession[];
    /** Most recent `lastSeenAt` across all sessions, or null if the user has never logged in. */
    lastActiveAt: number | null;
}

// ---- OIDC provider -----------------------------------------------------------------
//
// A client is a relying party registered by the owner to sign in via Server
// Central's built-in OpenID Connect provider (no dynamic client registration) —
// just OIDC credentials (id/secret + redirect URIs). Independent of the
// ComposeStack entity below: an OIDC client is usually something SC does *not*
// run, and a stack usually has no login to register. (Historical note, since it
// explains some churn in git: this type was briefly named `App` as a placeholder,
// and the name later went to the compose-stack concept before that was renamed
// again to `ComposeStack`.) Roles are exposed as a `groups` claim on the ID
// token. See apps/server/src/features/oidc/ for the provider implementation.

export interface OidcClient {
    id: string;
    name: string;
    redirectUris: string[];
    createdAt: number;
}

/** Query params an authorization request carries, whether read from the RP's
 *  redirect (`GET /oidc/authorize`) or forwarded by the SPA's confirm screen. */
export interface OidcAuthorizeParams {
    clientId: string;
    redirectUri: string;
    scope: string;
    state: string;
    codeChallenge: string;
    codeChallengeMethod: "S256";
    nonce?: string;
}

// ---- Compose stacks ----------------------------------------------------------
//
// A ComposeStack is a directory on a host containing a compose file (source of
// truth for what runs — no SC-native service format) and, for stacks SC created
// or imported, `sc-stack.json`. Bind mounts are whatever the compose file says;
// SC doesn't impose a layout. Design: doc/idea_app_system.md.
//
// This is what SC *registered*; `DockerStack` above is what SC *observes* from
// container labels. They're merged by `project` in the host's Docker → Stacks
// section: a registered stack with no containers is simply down, and an observed
// stack with no record is one deployed by hand, which can be adopted.
//
// `project` is the `docker compose -p` value, fixed at create/import time so
// actions always target the same compose project regardless of what the compose
// file's own `name:`/directory-basename prediction would produce.

export interface ComposeStack {
    id: string;
    name: string;
    hostId: string;
    /** Absolute path on hostId. */
    dir: string;
    /** Relative to dir, default "compose.yaml". */
    composeFile: string;
    project: string;
    createdAt: number;
}

export interface ComposeServiceStatus {
    name: string;
    /** Container backing this service right now, absent when it has none.
     *  Lets the services table link straight to the container's detail page. */
    containerId?: string;
    image?: string;
    /** Raw state string from `docker compose ps` (e.g. "running", "exited (0)"), absent when the service has no container yet. */
    state?: string;
    ports?: string;
    up: boolean;
}

export type ComposeStackRunStatus = "running" | "partial" | "stopped" | "down";

export interface ComposeStackStatus {
    status: ComposeStackRunStatus;
    services: ComposeServiceStatus[];
}

/**
 * Everything the host's Compose stacks section renders, in one call.
 *
 * Reading this *adopts*: any compose project observed running on the host that
 * SC has no record of, and whose containers carry a `config_files` label
 * pointing at a real compose file, is registered on the spot. Adoption is
 * control-plane only — nothing is written to the host — so it's cheap and
 * reversible by removing the stack again.
 *
 * `observed` is every compose project seen on the host right now, for container
 * counts and states. A project in `observed` with no matching entry in `stacks`
 * is one adoption couldn't place (no usable `config_files` label); it still
 * renders, just without a detail page.
 */
export interface HostComposeStacks {
    available: boolean;
    error?: string;
    stacks: ComposeStack[];
    observed: DockerStack[];
}

/** Result of probing a candidate host directory before import — step 2 of the
 *  import flow ("Detected"). */
export interface ComposeStackDetection {
    composeFound: boolean;
    manifestFound: boolean;
    /** From the directory's basename — compose's own default project-name rule. */
    predictedName: string;
    services: string[];
    /** Set when a compose file was found but `docker compose config` failed or
     *  returned unparsable output — `services` stays `[]` in that case too, but
     *  this distinguishes "couldn't ask" from "genuinely no services declared". */
    composeError?: string;
    /** Bind mounts whose source resolves outside `dir` — these stay where they
     *  are on import; the Files tab only ever browses `dir` itself. */
    externalBindMounts: { source: string; target: string }[];
    namedVolumeCount: number;
}

// ---- Reverse proxy ---------------------------------------------------------------
//
// SC-managed Caddy on one designated node, HTTP(S) only. Routes store intent
// (node + published host port), never a resolved IP — the control plane renders
// them to Caddy JSON (resolving each node's LAN IP at render time) and pushes
// the config through the node's agent to Caddy's loopback-bound admin API.
// Design: doc/idea_reverse_proxy.md.

export interface ProxyConfig {
    /** Node the Caddy container runs on. */
    nodeId: string;
    /** ACME registration email, used when certMode is "auto". */
    acmeEmail?: string;
    /** "auto" = Caddy automatic HTTPS (public hostnames, ACME); "internal" =
     *  Caddy's local CA for LAN-only hostnames. */
    certMode: "auto" | "internal";
    /** Host ports the container's 80/443 publish on; defaults 80/443. For
     *  nodes where those are taken (e.g. the platform's own web UI). ACME
     *  HTTP-01 and Caddy's HTTP→HTTPS redirects still assume the *public*
     *  side reaches 80/443, so non-standard ports lean on router mappings. */
    httpPort?: number;
    httpsPort?: number;
}

export interface ProxyRouteTarget {
    nodeId: string;
    /** Published host port on that node. */
    port: number;
    /** Scheme Caddy dials the upstream with. */
    scheme: "http" | "https";
    /** Skip upstream TLS verification, for apps self-serving HTTPS with a
     *  self-signed cert. Only meaningful when scheme is "https". */
    insecureSkipVerify?: boolean;
}

export interface ProxyRoute {
    id: string;
    /** Hostname the route matches, e.g. "jellyfin.example.com". */
    host: string;
    /** Optional path prefix the route matches, e.g. "/api". */
    pathPrefix?: string;
    target: ProxyRouteTarget;
    /** Disabled routes are kept but not rendered into the proxy config. */
    enabled: boolean;
}

/** Outcome of the last attempt to render + push config to the proxy. */
export interface ProxyApplyResult {
    ok: boolean;
    error?: string;
    at: number;
}

/** The proxy container as observed on the designated node right now. */
export interface ProxyContainerStatus {
    present: boolean;
    /** Container state (running | exited | …) when present. */
    state?: string;
    /** Human status, e.g. "Up 3 days", when present. */
    status?: string;
    /** Image the container was created from, when present. */
    image?: string;
    /** Why the container couldn't be inspected (node offline, docker missing). */
    error?: string;
    /** The detached deploy chain is still running (pulling, or replacing the old
     *  container) and hasn't produced a container yet — pending, not broken. */
    deploying?: boolean;
}

export interface ProxyState {
    config: ProxyConfig | null;
    routes: ProxyRoute[];
    /** Null until a proxy node is configured. */
    container: ProxyContainerStatus | null;
    lastApply: ProxyApplyResult | null;
}

// ---- ZFS -------------------------------------------------------------------------
//
// Full pool/vdev/dataset/snapshot lifecycle, driven by shelling `zpool`/`zfs` on the
// agent's host (see apps/server/src/features/zfs/zfs.ts) — the same "parse a CLI" shape as
// docker.ts/systemd.ts, not a new protocol message. Design: doc/idea_zfs.md.
// Pool/vdev topology mutations run through the task system (see TaskSpec's zfs_*
// variants) for an audit trail and are gated owner-only by the ZFS feature; dataset/
// snapshot mutations run the same way but aren't role-gated (matching the rest of
// the task system today — see the Role doc comment below on per-op RBAC).

export type ZfsHealth = "ONLINE" | "DEGRADED" | "FAULTED" | "OFFLINE" | "UNAVAIL" | "REMOVED";

export interface ZfsDevice {
    /** A `/dev/disk/by-id/*` path where resolvable, else the raw name zpool printed. */
    name: string;
    type: "disk" | "file" | "spare" | "cache" | "log";
    state: ZfsHealth;
    readErrors: number;
    writeErrors: number;
    checksumErrors: number;
}

export type ZfsVdevType = "stripe" | "mirror" | "raidz1" | "raidz2" | "raidz3" | "spare" | "log" | "cache";

export interface ZfsVdev {
    type: ZfsVdevType;
    state: ZfsHealth;
    devices: ZfsDevice[];
}

export interface ZfsScanStatus {
    kind: "scrub" | "resilver";
    state: "in_progress" | "completed" | "cancelled";
    startedAt: number;
    finishedAt?: number;
    pctDone?: number;
    eta?: string;
}

export interface ZfsPool {
    name: string;
    state: ZfsHealth;
    sizeBytes: number;
    allocatedBytes: number;
    freeBytes: number;
    fragmentationPct: number;
    capacityPct: number;
    /** Raw summary line from `zpool status`, e.g. "No known data errors". */
    errors: string;
    scan: ZfsScanStatus | null;
    vdevs: ZfsVdev[];
}

export interface ZfsDataset {
    name: string; // "tank/media"
    pool: string;
    type: "filesystem" | "volume";
    usedBytes: number;
    availBytes: number;
    referBytes: number;
    mountpoint: string | null;
    mounted: boolean;
    /** Whether ZFS auto-mounts this dataset at import/boot (via zfs-mount.service —
     *  distinct from /etc/fstab, which ZFS mounts normally don't appear in at all).
     *  "noauto" means mountable but excluded from `zfs mount -a`. */
    canmount: "on" | "off" | "noauto";
    compression: string;
    compressRatio: number;
    quotaBytes: number | null;
    recordsize?: number; // filesystem only
    volsizeBytes?: number; // volume (zvol) only
    /** Parent snapshot, if this dataset is a clone. */
    origin?: string;
}

export interface ZfsSnapshot {
    name: string; // "tank/media@2026-08-12"
    dataset: string;
    createdAt: number;
    usedBytes: number;
    referBytes: number;
}

export interface ZfsBlockDevice {
    name: string; // "sda"
    /** `/dev/disk/by-id/*` paths for this device — preferred for all pool/vdev ops
     *  since `/dev/sdX` ordering isn't stable across reboots. */
    byIdPaths: string[];
    sizeBytes: number;
    model: string;
    serial: string;
    rotational: boolean;
    inUse: "zfs" | "mounted" | "partitioned" | null;
    /** e.g. pool name or mountpoint, when inUse is set. */
    inUseDetail?: string;
}

export interface ZfsState {
    /** False when the `zpool`/`zfs` binaries aren't present — most hosts outside
     *  TrueNAS/ZFS-on-Linux setups. The ZFS tab grays out rather than erroring. */
    available: boolean;
    error?: string;
    pools: ZfsPool[];
}

// ---- Mounts ------------------------------------------------------------------------
//
// Every real (non-pseudo) filesystem currently mounted on a host — driven by
// `findmnt --real` on the agent (see apps/server/src/host-mounts.ts), cross-checked
// against /etc/fstab and, for ZFS mounts, `zfs get canmount` to answer "will this
// survive a reboot" — the two mechanisms don't overlap (ZFS mounts are governed by
// zfs-mount.service, not fstab, and normally never appear in fstab at all).

export interface MountAutoMountInfo {
    /** Whether this mount is expected to come back after a reboot. */
    enabled: boolean;
    /** What mechanism (if any) is responsible. */
    source: "fstab" | "zfs" | "none";
    /** Human-readable reason, e.g. "noauto in /etc/fstab", "canmount=off". */
    detail: string;
}

export interface MountInfo {
    /** findmnt's "source" — a block device path, a ZFS dataset name, "tmpfs", etc. */
    device: string;
    mountpoint: string;
    fstype: string;
    options: string[];
    sizeBytes: number;
    usedBytes: number;
    availBytes: number;
    autoMount: MountAutoMountInfo;
}

export interface MountsState {
    /** False when `findmnt` isn't present (non-Linux hosts). */
    available: boolean;
    error?: string;
    mounts: MountInfo[];
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

    // Users (owner-only)
    listUsers: { data: void; response: UserInfo[] };
    createUser: { data: { username: string; password: string; role: AssignableRole }; response: UserInfo };
    deleteUser: { data: { userId: string }; response: void };
    updateUserRole: { data: { userId: string; role: AssignableRole }; response: void };
    // Sessions + last-active, fetched on demand when a row expands in the Users tab.
    getUserDetail: { data: { userId: string }; response: UserDetail };
    revokeUserSession: { data: { userId: string; sessionId: string }; response: void };
    // Resets a user's password; revokes all of that user's sessions so the new
    // password takes effect immediately.
    adminSetPassword: { data: { userId: string; password: string }; response: void };
    // Map a user to an OS account (null clears the mapping). See UserInfo.systemUser.
    setUserSystemUser: { data: { userId: string; systemUser: string | null }; response: void };

    // OIDC clients (owner-only admin)
    listOidcClients: { data: void; response: OidcClient[] };
    // clientSecret is returned once, at creation, and never again.
    createOidcClient: { data: { name: string; redirectUris: string[] }; response: { client: OidcClient; clientSecret: string } };
    deleteOidcClient: { data: { clientId: string }; response: void };

    // OIDC front-channel (authenticated user, driven by the /oidc/authorize SPA route).
    // The actual code-for-token exchange happens over raw HTTP at POST /oidc/token
    // (form-encoded, per spec), not through this RPC layer.
    getOidcAuthorizeRequest: { data: OidcAuthorizeParams; response: { appName: string; redirectUri: string } };
    completeOidcAuthorize: { data: OidcAuthorizeParams; response: { redirectUrl: string } };

    // SC-managed compose stacks — a directory + compose file on a host.
    // See doc/idea_app_system.md.
    listComposeStacks: { data: void; response: ComposeStack[] };
    // One host's section: registered stacks (adopting observed ones as a side
    // effect) plus what's running. See HostComposeStacks.
    listHostComposeStacks: { data: { hostId: string }; response: HostComposeStacks };
    // Always scaffolds an empty compose.yaml + volumes/ under dir.
    // `content` seeds the new stack's compose.yaml (the "Paste YAML" path in the
    // new-stack modal); omitted, the file is scaffolded with a bare `services:`.
    createComposeStack: { data: { name: string; hostId: string; dir: string; content?: string }; response: ComposeStack };
    // Probes a candidate directory before import (step 2 of the import flow).
    detectComposeStack: { data: { hostId: string; dir: string }; response: ComposeStackDetection };
    // Always mints a fresh id, even when dir already has a manifest.
    importComposeStack: { data: { hostId: string; dir: string; name: string }; response: ComposeStack };
    // Unregisters the stack. `deleteDir: true` also removes its directory (compose
    // file, manifest, and volumes/) from the host; otherwise it's left on disk.
    deleteComposeStack: { data: { stackId: string; deleteDir: boolean }; response: void };
    getComposeStackStatus: { data: { stackId: string }; response: ComposeStackStatus };
    // `docker compose logs`, optionally scoped to one service — one-shot (not
    // streaming), same 30s exec ceiling as everything else pre-streaming-exec.
    getComposeStackLogs: { data: { stackId: string; service?: string; tail?: number }; response: { logs: string } };
    // Validates in-editor compose content via `docker compose config`, against a
    // temp file — never touches the stack's real compose.yaml. Used by the Compose
    // tab's visual/YAML editor before Save, on top of client-side schema validation.
    validateComposeContent: {
        data: { stackId: string; content: string };
        response: { valid: true } | { valid: false; error: string };
    };

    // Servers
    getServers: { data: void; response: ServerEntry[] };
    // Forget a server. Only offline agents can be removed (the embedded host and
    // currently-connected agents are rejected).
    deleteServer: { data: { serverId: string }; response: void };
    // Re-run the host capability probes on a connected node and return the fresh
    // report. Probes also run unprompted at identify; this is the "I just
    // installed ZFS, stop greying out the tab" button.
    redetectHostCapabilities: { data: { serverId: string }; response: HostCapabilityReport };

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
    // (container/stack lifecycle actions and image pull moved to the task system
    // — `service_action`/`docker_stack_action`/`docker_container_action`/
    // `docker_image_pull` kinds via `runTask` — for run history + logs)
    dockerList: { data: { serverId: string }; response: DockerState };
    dockerContainerLogs: { data: { serverId: string; containerId: string; timestamps?: boolean } & LogQuery; response: { logs: string } };
    dockerOverview: { data: { serverId: string }; response: DockerOverview };
    dockerContainerInspect: { data: { serverId: string; containerId: string }; response: DockerContainerDetail };
    // One-shot, non-interactive command run inside a running container/service —
    // `docker exec`/`docker compose exec` under the hood, not an attached shell.
    dockerContainerExec: { data: { serverId: string; containerId: string; command: string }; response: DockerExecResult };
    dockerVolumeInspect: { data: { serverId: string; name: string }; response: DockerVolumeDetail };
    dockerVolumeRemove: { data: { serverId: string; name: string }; response: void };
    dockerImageAction: { data: { serverId: string; imageId: string; action: ImageAction }; response: void };
    // Volume/port/env suggestions from what the image's Dockerfile already
    // declares — empty fields if the image isn't pulled locally yet.
    dockerImageDefaults: { data: { serverId: string; image: string }; response: ImageDefaults };

    // Processes
    getProcesses: { data: { serverId: string }; response: ProcessInfo[] };

    // Networking — adapters, addresses, routes, and the agent's remote IP.
    getNetworkInfo: { data: { serverId: string }; response: NetworkInfo };

    // System users — real OS accounts on a host, and creating new ones (owner-only).
    systemUsersList: { data: { serverId: string }; response: SystemUsersState };
    systemUserCreate: { data: { serverId: string; username: string; groups: string[] }; response: void };
    // Presence of one OS account across every host in the fleet.
    systemUserHostStatus: { data: { username: string }; response: SystemUserHostStatus[] };
    // Replace an account's supplementary groups (usermod -G; owner-only).
    systemUserSetGroups: { data: { serverId: string; username: string; groups: string[] }; response: void };

    // Systemd — list services, view logs and unit files. Service actions
    // (start/stop/restart/enable/disable) moved to the task system's
    // `service_action` kind via `runTask`, for run history + logs.
    systemdList: { data: { serverId: string }; response: SystemdState };
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
    // force bypasses the agent's "already installed" refusal, overwriting the
    // existing config/cert/binaries — for repairing a broken/partial prior install.
    installNodeService: {
        data: { serverId: string; installDir: string | null; dataDir: string | null; mechanism: InstallMechanism; force?: boolean };
        response: { startCommand: string | null };
    };

    // Probe a candidate install/data directory on an agent's host (writable + exec).
    probeInstallPath: { data: { serverId: string; path: string }; response: InstallProbeResult };

    // Update an installed agent to the control plane's current AGENT_VERSION —
    // moved to the task system's `update_agent` kind via `runTask`, for run
    // history + logs. force bypasses the "already up to date" check (e.g.
    // re-pushing a dev rebuild whose AGENT_VERSION string didn't change).

    // Control plane (the server itself): its running version vs. the latest release,
    // and a self-update that swaps the binary and restarts. updateAvailable is false
    // unless the control plane is installed as a service and a newer release exists.
    getControlPlaneStatus: {
        data: void;
        response: { version: string; installed: boolean; latestVersion: string | null; updateAvailable: boolean };
    };
    updateControlPlane: { data: void; response: void };

    // Config
    getConfig: {
        data: void;
        response: {
            /** Agents' address for the node server (:4142) — not a browser-facing URL. */
            domain: string | null;
            /** Canonical public URL of this control plane; also the OIDC issuer. */
            primaryUrl: string | null;
            /** Other origins allowed to call the API cross-origin. */
            allowedOrigins: string[];
            /** Proxies whose forwarded client-address header is believed, and the
             *  header each writes ("" = use forwardedHeader). */
            trustedProxies: { address: string; header: string }[];
            /** Header used for trusted proxies that don't name one of their own. */
            forwardedHeader: string;
            /** True when SC_TRUSTED_PROXIES is set: the env wins, so the UI must
             *  show the list read-only rather than accept a save it would override. */
            trustedProxiesLocked: boolean;
            /** OIDC clients trusting the current primaryUrl as their `iss`. Non-zero
             *  means changing it breaks them, so the UI warns and `force` is required. */
            oidcClientCount: number;
        };
    };
    setDomain: { data: { domain: string | null }; response: void };
    // The canonical public URL browsers reach this control plane at (e.g.
    // "https://central.example.com"). Doubles as the OIDC `iss` claim and
    // discovery-document base, so it must stay stable once a client trusts it:
    // changing it while OIDC clients exist is refused unless `force` is set.
    setPrimaryUrl: { data: { primaryUrl: string | null; force?: boolean }; response: void };
    // Origins permitted to read API responses cross-origin. This is for *other*
    // apps calling the API — the web UI is same-origin and needs no entry. Empty
    // keeps the permissive `Access-Control-Allow-Origin: *` default.
    setAllowedOrigins: { data: { allowedOrigins: string[] }; response: void };
    // Proxies whose forwarded header is believed when resolving a client IP, each
    // optionally naming the header it writes (empty = the configured default).
    // Refused while SC_TRUSTED_PROXIES is set, since the environment overrides it.
    setTrustedProxies: { data: { trustedProxies: { address: string; header: string }[] }; response: void };

    // Reverse proxy (owner-only). Route mutations re-apply the rendered config
    // immediately; the result lands in ProxyState.lastApply.
    getProxyState: { data: void; response: ProxyState };
    // Persist the proxy config (null clears it). Doesn't deploy by itself.
    setProxyConfig: { data: { config: ProxyConfig | null }; response: void };
    // Start (or repair) the Caddy container on the configured node. The image
    // pull + run happens detached on the host — poll getProxyState for progress.
    deployProxy: { data: void; response: void };
    // Remove the proxy container (named volumes with certs/config survive).
    removeProxy: { data: void; response: void };
    createProxyRoute: { data: { route: Omit<ProxyRoute, "id"> }; response: ProxyRoute };
    updateProxyRoute: { data: { route: ProxyRoute }; response: void };
    deleteProxyRoute: { data: { routeId: string }; response: void };
    // Re-render + push the config on demand (retry after a failed apply).
    applyProxyConfig: { data: void; response: ProxyApplyResult };

    // ZFS — read-only + low-risk direct ops. Pool/vdev/dataset/snapshot mutations
    // go through the task system (runTask with a zfs_* spec) instead, for the
    // audit trail — see doc/idea_zfs.md.
    getZfsState: { data: { serverId: string }; response: ZfsState };
    getZfsDatasets: { data: { serverId: string; pool?: string }; response: ZfsDataset[] };
    getZfsSnapshots: { data: { serverId: string; dataset?: string }; response: ZfsSnapshot[] };
    getZfsBlockDevices: { data: { serverId: string }; response: ZfsBlockDevice[] };
    setDatasetProperty: { data: { serverId: string; name: string; key: string; value: string }; response: void };

    // Mounts — every real filesystem currently mounted, and whether it'll survive a reboot.
    getMounts: { data: { serverId: string }; response: MountsState };
    // Mappable device nodes (`/dev/serial/by-id`, tty, dri, video, tun) — what the
    // compose editor's `devices:` picker offers, not a full /dev listing.
    listHostDevices: { data: { serverId: string }; response: HostDevices };

    // Tasks — the uniform envelope (history, typed last-result, run-now).
    // (Cancellation and schedules are deferred until a task kind needs them;
    // the wire types for those already live in ./tasks.)
    listTasks: { data: { target?: string | null; kind?: TaskSpec["kind"]; limit?: number }; response: TaskRun[] };
    getTask: { data: { id: string }; response: TaskRun | null };
    // Run-now: create + start a run immediately. Returns its id to navigate to.
    runTask: { data: { spec: TaskSpec; target: string | null }; response: { id: string } };
    // Seed a run's log buffer (in-memory only, empty for kinds that don't log or
    // after a control-plane restart); live updates arrive via the `taskLog` event.
    getTaskLogs: { data: { id: string }; response: TaskLogLine[] };
};

// ---- WebSocket events ----------------------------------------------------------

export type ApiEvent =
    | { kind: "init"; data: { servers: ServerEntry[]; metricsHistory: Record<string, MetricsSnapshot[]>; tasks: TaskRun[] } }
    | { kind: "serversUpdate"; data: ServerEntry[] }
    | { kind: "statusUpdate"; data: ServerStatus }
    | { kind: "metrics"; data: { serverId: string; snapshot: MetricsSnapshot } }
    // A run was created or changed status. Carries the full envelope.
    | { kind: "taskUpdate"; data: TaskRun }
    // New log lines appended for a run. Only fires for kinds that call ctx.log.
    | { kind: "taskLog"; data: { taskId: string; lines: TaskLogLine[] } };

// ---- Terminal protocol (WebSocket at /terminal?serverId=...) --------------------

export type TerminalClientMessage =
    | { type: "input"; data: string }
    | { type: "resize"; cols: number; rows: number };

export type TerminalServerMessage =
    | { type: "data"; data: string }
    | { type: "exit"; code: number | null }
    | { type: "error"; message: string };
