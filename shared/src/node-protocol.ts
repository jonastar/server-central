import type { DirEntry, FileContent, MetricsSnapshot, SystemInfo } from "./index";

export interface NodeExecResult {
    stdout: string;
    stderr: string;
    code: number;
}

// ---- Node → Control ----------------------------------------------------------

export type NodeMessage =
    | { type: "identify"; token: string; info: SystemInfo }
    | { type: "metrics"; snapshot: MetricsSnapshot }
    | { type: "execResponse"; requestId: string; result: NodeExecResult }
    | { type: "listDirResponse"; requestId: string; result: { path: string; entries: DirEntry[] } }
    | { type: "readFileResponse"; requestId: string; result: FileContent }
    | { type: "writeFileResponse"; requestId: string }
    | { type: "deletePathResponse"; requestId: string }
    | { type: "renameResponse"; requestId: string }
    | { type: "shellData"; sessionId: string; data: string }
    | { type: "shellExit"; sessionId: string; code: number | null }
    | { type: "error"; requestId?: string; message: string };

// ---- Control → Node ----------------------------------------------------------

export type ControlMessage =
    | { type: "acknowledged"; nodeId: string }
    | { type: "execRequest"; requestId: string; command: string }
    | { type: "listDirRequest"; requestId: string; path: string }
    | { type: "readFileRequest"; requestId: string; path: string }
    | { type: "writeFileRequest"; requestId: string; path: string; content: string }
    | { type: "deletePathRequest"; requestId: string; path: string }
    | { type: "renamePathRequest"; requestId: string; from: string; to: string }
    | { type: "openShell"; sessionId: string; cols: number; rows: number }
    | { type: "shellInput"; sessionId: string; data: string }
    | { type: "shellResize"; sessionId: string; cols: number; rows: number }
    | { type: "closeShell"; sessionId: string };