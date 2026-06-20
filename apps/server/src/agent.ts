import type { AgentMode, DirEntry, FileContent, MetricsSnapshot, ServerStatus } from "@central/shared";

export interface ExecResult {
    stdout: string;
    stderr: string;
    code: number;
}

/** An interactive PTY session on the agent's host. */
export interface ShellSession {
    onData(cb: (data: string) => void): void;
    onExit(cb: (code: number | null) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    close(): void;
}

/**
 * Everything Server Central needs from a managed host. Implemented in-process
 * by LocalAgent today; a remote-agent transport will implement the same
 * surface later.
 */
export interface HostAgent {
    readonly id: string;
    readonly name: string;
    /** How this agent is running on its host. Drives fleet priority. */
    readonly mode: AgentMode;

    status(): ServerStatus;
    /** In-process metrics history, oldest first. */
    readonly history: MetricsSnapshot[];

    /**
     * Demote a connection-backed agent to a standby/dummy: it stops being the
     * active agent for its machine and suppresses metrics. Connection-backed
     * agents (NodeProxy) implement this; the embedded agent does not.
     */
    deactivate?(): void;

    /** Promote a previously-demoted agent back to active (inverse of deactivate). */
    activate?(): void;

    /** Run a shell command, capturing output. */
    exec(command: string): Promise<ExecResult>;

    // Files
    listDir(path: string): Promise<{ path: string; entries: DirEntry[] }>;
    readFile(path: string): Promise<FileContent>;
    writeFile(path: string, content: string): Promise<void>;
    createDir(path: string): Promise<void>;
    deletePath(path: string): Promise<void>;
    renamePath(from: string, to: string): Promise<void>;

    /** Open an interactive shell with an initial terminal size. */
    openShell(cols: number, rows: number): Promise<ShellSession>;

    /**
     * Promote a live agent to a permanent systemd service, using a durable token
     * to reconnect. Only remote, connection-backed agents support this; the
     * embedded agent (the control plane's own host) does not.
     */
    installService?(agentToken: string): Promise<void>;
}
