import type { DirEntry, FileContent, MetricsSnapshot, ServerStatus } from "@central/shared";

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

    status(): ServerStatus;
    /** In-process metrics history, oldest first. */
    readonly history: MetricsSnapshot[];

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
}
