import type { AgentMode, DirEntry, FileContent, InstallMechanism, InstallProbeResult, MetricsSnapshot, SystemInfo } from "./index";

export interface NodeExecResult {
    stdout: string;
    stderr: string;
    code: number;
}

// ---- Node → Control ----------------------------------------------------------

export type NodeMessage =
    | { type: "identify"; token: string; info: SystemInfo; machineId: string; mode: AgentMode }
    | { type: "metrics"; snapshot: MetricsSnapshot }
    | { type: "execResponse"; requestId: string; result: NodeExecResult }
    | { type: "listDirResponse"; requestId: string; result: { path: string; entries: DirEntry[] } }
    | { type: "readFileResponse"; requestId: string; result: FileContent }
    | { type: "writeFileResponse"; requestId: string }
    | { type: "uploadFileResponse"; requestId: string }
    | { type: "deletePathResponse"; requestId: string }
    | { type: "renameResponse"; requestId: string }
    | { type: "shellData"; sessionId: string; data: string }
    | { type: "shellExit"; sessionId: string; code: number | null }
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
    | { type: "deletePathRequest"; requestId: string; path: string }
    | { type: "renamePathRequest"; requestId: string; from: string; to: string }
    | { type: "openShell"; sessionId: string; cols: number; rows: number }
    | { type: "shellInput"; sessionId: string; data: string }
    | { type: "shellResize"; sessionId: string; cols: number; rows: number }
    | { type: "closeShell"; sessionId: string }
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