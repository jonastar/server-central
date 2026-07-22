import type { AgentMode, DirEntry, FileContent, InstallMechanism, InstallProbeResult, MetricsSnapshot, SystemInfo } from "./index";

export interface NodeExecResult {
    stdout: string;
    stderr: string;
    code: number;
}

/** Response to an httpRequest — the status and (size-capped) body of an HTTP
 *  request the agent performed from its host. Network-level failures come back
 *  as a protocol `error` message instead, like other request kinds. */
export interface NodeHttpResult {
    status: number;
    body: string;
}

// ---- Node → Control ----------------------------------------------------------

export type NodeMessage =
    // capabilities: post-v0.6.0 message kinds this agent handles (see
    // AGENT_CAPABILITIES). Absent from older agents — treated as none.
    | { type: "identify"; token: string; info: SystemInfo; machineId: string; mode: AgentMode; capabilities?: string[] }
    | { type: "metrics"; snapshot: MetricsSnapshot }
    | { type: "execResponse"; requestId: string; result: NodeExecResult }
    | { type: "listDirResponse"; requestId: string; result: { path: string; entries: DirEntry[] } }
    | { type: "readFileResponse"; requestId: string; result: FileContent }
    | { type: "writeFileResponse"; requestId: string }
    | { type: "uploadFileResponse"; requestId: string }
    | { type: "createDirResponse"; requestId: string }
    | { type: "deletePathResponse"; requestId: string }
    | { type: "renameResponse"; requestId: string }
    | { type: "shellData"; sessionId: string; data: string }
    | { type: "shellExit"; sessionId: string; code: number | null }
    | { type: "httpResponse"; requestId: string; result: NodeHttpResult }
    | { type: "probeInstallPathResponse"; requestId: string; result: InstallProbeResult }
    | { type: "installServiceResponse"; requestId: string; startCommand: string | null }
    | { type: "updateServiceResponse"; requestId: string }
    | { type: "error"; requestId?: string; message: string };

// ---- Control → Node ----------------------------------------------------------

export type ControlMessage =
    | { type: "acknowledged"; nodeId: string; active: boolean }
    | { type: "execRequest"; requestId: string; command: string }
    | { type: "listDirRequest"; requestId: string; path: string }
    | { type: "readFileRequest"; requestId: string; path: string }
    | { type: "writeFileRequest"; requestId: string; path: string; content: string }
    | { type: "uploadFileRequest"; requestId: string; path: string; contentBase64: string }
    | { type: "createDirRequest"; requestId: string; path: string }
    | { type: "deletePathRequest"; requestId: string; path: string }
    | { type: "renamePathRequest"; requestId: string; from: string; to: string }
    // asUser: OS account to run the shell as (via runuser/su; the agent runs as
    // root). Null/absent means the agent's own user — the pre-mapping behavior.
    | { type: "openShell"; sessionId: string; cols: number; rows: number; asUser?: string | null }
    | { type: "shellInput"; sessionId: string; data: string }
    | { type: "shellResize"; sessionId: string; cols: number; rows: number }
    | { type: "closeShell"; sessionId: string }
    // Perform an HTTP request from the agent's host and return status + body.
    // Exists for endpoints only reachable from that host's vantage point — the
    // proxy container's loopback-bound admin API, upstream reachability probes.
    // Grants nothing exec doesn't already; older agents ignore it (times out).
    | { type: "httpRequest"; requestId: string; url: string; method: "GET" | "POST"; contentType?: string; body?: string }
    // Probe a candidate install/data dir (writable + exec-capable) for the setup wizard.
    | { type: "probeInstallPathRequest"; requestId: string; path: string }
    // Ask a live agent to install itself as a permanent service. The agentToken is a
    // durable credential the installed service uses to reconnect. installDir (binary)
    // and dataDir (cert/config/state) are null to use the agent defaults. mechanism
    // "systemd" writes a unit; "manual" lays down files and replies with a startCommand.
    | { type: "installService"; requestId: string; agentToken: string; installDir: string | null; dataDir: string | null; mechanism: InstallMechanism }
    // Ask an installed agent to update itself to `version`: download that binary
    // from the control plane, repoint its symlink, and restart into it.
    | { type: "updateService"; requestId: string; version: string };