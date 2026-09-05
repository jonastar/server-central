import pkg from "../../package.json" with { type: "json" };
import type { HostCapabilityReport } from "./host-capabilities";
import type { MetricsSnapshot } from "../metrics";

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
export const AGENT_CAPABILITIES: readonly string[] = ["httpRequest", "stun", "heartbeat", "hostCapabilities", "execStream", "shellAsUser", "execArgv", "resolvePaths"];

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


/** Fleet inventory, node enrollment, and the control plane's own version. */
export interface ServersOperations {
    list: { data: void; response: ServerEntry[] };
    // Forget a server. Only offline agents can be removed (the embedded host and
    // currently-connected agents are rejected).
    delete: { data: { serverId: string }; response: void };
    getMetricsHistory: { data: { serverId: string }; response: MetricsSnapshot[] };
    // Re-run the host capability probes on a connected node and return the fresh
    // report. Probes also run unprompted at identify; this is the "I just
    // installed ZFS, stop greying out the tab" button.
    redetectCapabilities: { data: { serverId: string }; response: HostCapabilityReport };

    // useExternal builds the command around the control plane's external host
    // (configured domain, else discovered WAN IP) instead of the LAN IP, for
    // enrolling a machine that isn't on the same network. externalHost in the
    // response is that host (null when none is known) so the UI can offer the
    // toggle only when it would work.
    generateInstallCommand: {
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
    installService: {
        data: { serverId: string; installDir: string | null; dataDir: string | null; mechanism: InstallMechanism; force?: boolean };
        response: { startCommand: string | null };
    };

    /** Probe a candidate install/data directory on an agent's host (writable + exec). */
    probeInstallPath: { data: { serverId: string; path: string }; response: InstallProbeResult };

    // Updating an installed agent to the control plane's current AGENT_VERSION is
    // the task system's `update_agent` kind via `runTask`, for run history + logs.
}
