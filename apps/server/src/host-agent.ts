import type { AgentMode, ControlMessage, DirEntry, FileContent, MetricsSnapshot, NodeMessage, ServerStatus, SystemInfo } from "@central/shared";

const REQUEST_TIMEOUT_MS = 30_000;

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
 * The control plane's handle to a managed host — everything Server Central needs
 * from a host, expressed as control messages sent over an abstract transport.
 *
 * One class serves every host: remote nodes (`sendControl` writes to a WebSocket)
 * and the embedded host (`sendControl` hands the message to an in-process Agent —
 * see {@link ./embedded-agent}). The transport is the only difference.
 */
export class HostAgent {
    readonly id: string;
    readonly name: string;
    /** How this agent runs on its host. Drives fleet priority (installed > live). */
    readonly mode: AgentMode;
    readonly history: MetricsSnapshot[] = [];

    private info: SystemInfo | null;
    private connected = true;
    /** False once demoted to a standby/dummy by a higher-priority agent. */
    private active = true;

    private readonly pending = new Map<string, { resolve: (msg: NodeMessage) => void; reject: (err: Error) => void }>();
    private readonly shells = new Map<string, { onData: (d: string) => void; onExit: (c: number | null) => void }>();

    constructor(
        private readonly sendControl: (msg: ControlMessage) => void,
        nodeId: string,
        name: string,
        info: SystemInfo | null,
        private readonly onMetrics: (serverId: string, snapshot: MetricsSnapshot) => void,
        mode: AgentMode = "live",
    ) {
        this.id = nodeId;
        this.name = name;
        this.info = info;
        this.mode = mode;
    }

    /** Update system info (used by the embedded agent after it collects info on start). */
    setInfo(info: SystemInfo): void {
        this.info = info;
    }

    /** Demote to a standby/dummy: stop forwarding metrics, drop active state. */
    deactivate(): void {
        this.active = false;
    }

    /** Promote back to the active agent for its machine (e.g. the active one disconnected). */
    activate(): void {
        this.active = true;
    }

    status(): ServerStatus {
        return {
            serverId: this.id,
            state: this.connected ? "online" : "offline",
            info: this.info ?? undefined,
            mode: this.mode,
        };
    }

    /** Called when a NodeMessage arrives (from a WebSocket or an in-process Agent). */
    receive(msg: NodeMessage): void {
        if (msg.type === "metrics") {
            // A demoted dummy still streams metrics over its own socket; ignore
            // them so the active agent for this machine is the only source.
            if (!this.active) return;
            this.history.push(msg.snapshot);
            if (this.history.length > 720) this.history.splice(0, this.history.length - 720);
            this.onMetrics(this.id, msg.snapshot);
            return;
        }
        if (msg.type === "shellData") {
            this.shells.get(msg.sessionId)?.onData(msg.data);
            return;
        }
        if (msg.type === "shellExit") {
            const session = this.shells.get(msg.sessionId);
            if (session) {
                session.onExit(msg.code);
                this.shells.delete(msg.sessionId);
            }
            return;
        }
        const requestId = (msg as { requestId?: string }).requestId;
        if (requestId) {
            const pending = this.pending.get(requestId);
            if (pending) {
                this.pending.delete(requestId);
                if (msg.type === "error") {
                    pending.reject(new Error(msg.message));
                } else {
                    pending.resolve(msg);
                }
            }
        }
    }

    /** Called when the connection drops (remote agents only; the embedded agent never disconnects). */
    disconnect(): void {
        this.connected = false;
        for (const { reject } of this.pending.values()) {
            reject(new Error("Node disconnected"));
        }
        this.pending.clear();
        for (const session of this.shells.values()) {
            session.onExit(null);
        }
        this.shells.clear();
    }

    private request<T extends NodeMessage>(msg: ControlMessage & { requestId: string }): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(msg.requestId);
                reject(new Error(`Request ${msg.requestId} timed out`));
            }, REQUEST_TIMEOUT_MS);

            this.pending.set(msg.requestId, {
                resolve: (response) => { clearTimeout(timer); resolve(response as T); },
                reject: (err) => { clearTimeout(timer); reject(err); },
            });
            this.sendControl(msg);
        });
    }

    // ---- Host operations --------------------------------------------------------

    async exec(command: string): Promise<ExecResult> {
        const resp = await this.request<Extract<NodeMessage, { type: "execResponse" }>>({
            type: "execRequest", requestId: crypto.randomUUID(), command,
        });
        return resp.result;
    }

    async listDir(dirPath: string): Promise<{ path: string; entries: DirEntry[] }> {
        const resp = await this.request<Extract<NodeMessage, { type: "listDirResponse" }>>({
            type: "listDirRequest", requestId: crypto.randomUUID(), path: dirPath,
        });
        return resp.result;
    }

    async readFile(filePath: string): Promise<FileContent> {
        const resp = await this.request<Extract<NodeMessage, { type: "readFileResponse" }>>({
            type: "readFileRequest", requestId: crypto.randomUUID(), path: filePath,
        });
        return resp.result;
    }

    async writeFile(filePath: string, content: string): Promise<void> {
        await this.request<Extract<NodeMessage, { type: "writeFileResponse" }>>({
            type: "writeFileRequest", requestId: crypto.randomUUID(), path: filePath, content,
        });
    }

    async createDir(dirPath: string): Promise<void> {
        const result = await this.exec(`mkdir -p "${dirPath.replace(/"/g, '\\"')}"`);
        if (result.code !== 0) throw new Error(`mkdir failed: ${result.stderr}`);
    }

    async deletePath(targetPath: string): Promise<void> {
        await this.request<Extract<NodeMessage, { type: "deletePathResponse" }>>({
            type: "deletePathRequest", requestId: crypto.randomUUID(), path: targetPath,
        });
    }

    async renamePath(from: string, to: string): Promise<void> {
        await this.request<Extract<NodeMessage, { type: "renameResponse" }>>({
            type: "renamePathRequest", requestId: crypto.randomUUID(), from, to,
        });
    }

    /**
     * Promote a live agent to a permanent systemd service, using a durable token
     * to reconnect. Only meaningful for remote agents; the embedded agent (the
     * control plane's own host) has no install handler and will reject this.
     */
    async installService(agentToken: string): Promise<void> {
        await this.request<Extract<NodeMessage, { type: "installServiceResponse" }>>({
            type: "installService", requestId: crypto.randomUUID(), agentToken,
        });
    }

    async openShell(cols: number, rows: number): Promise<ShellSession> {
        const sessionId = crypto.randomUUID();
        let dataCb: (data: string) => void = () => { };
        let exitCb: (code: number | null) => void = () => { };

        this.shells.set(sessionId, {
            onData: (data) => dataCb(data),
            onExit: (code) => exitCb(code),
        });

        this.sendControl({ type: "openShell", sessionId, cols, rows });

        return {
            onData(cb) { dataCb = cb; },
            onExit(cb) { exitCb = cb; },
            write: (data) => this.sendControl({ type: "shellInput", sessionId, data }),
            resize: (c, r) => this.sendControl({ type: "shellResize", sessionId, cols: c, rows: r }),
            close: () => {
                this.shells.delete(sessionId);
                this.sendControl({ type: "closeShell", sessionId });
            },
        };
    }
}
