import type { AgentMode, ControlMessage, DirEntry, FileContent, InstallMechanism, InstallProbeResult, MetricsSnapshot, NodeHttpResult, NodeMessage, ServerStatus, SystemInfo } from "@central/shared";
import { METRICS_HISTORY_MAX } from "@central/shared";

const REQUEST_TIMEOUT_MS = 30_000;
/**
 * `uploadFile` alone can carry up to MAX_UPLOAD_BYTES (256MB, as base64 ~341MB) over
 * the same request/response channel as every quick RPC — the fixed 30s ceiling was
 * sized for those, not a few-hundred-MB transfer over a possibly slow link. A flat,
 * generous timeout here beats making every other request wait longer to fail.
 */
const UPLOAD_TIMEOUT_MS = 120_000;

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
    /** Source IP of the agent's connection as seen by the control plane (its public
     *  IP across NAT). Null for the embedded host. */
    readonly remoteIp: string | null;
    readonly history: MetricsSnapshot[] = [];

    private info: SystemInfo | null;
    private connected = true;
    /** False once demoted to a standby/dummy by a higher-priority agent. */
    private active = true;

    private readonly pending = new Map<string, { resolve: (msg: NodeMessage) => void; reject: (err: Error) => void }>();
    private readonly shells = new Map<string, { onData: (d: string) => void; onExit: (c: number | null) => void }>();

    /** Post-v0.6.0 message kinds the agent advertised at identify. Agents
     *  ignore unknown message types, so sending one to an agent that didn't
     *  advertise it would die as a silent protocol timeout — check here first. */
    private readonly capabilities: ReadonlySet<string>;

    constructor(
        private readonly sendControl: (msg: ControlMessage) => void,
        nodeId: string,
        name: string,
        info: SystemInfo | null,
        private readonly onMetrics: (serverId: string, snapshot: MetricsSnapshot) => void,
        mode: AgentMode = "live",
        remoteIp: string | null = null,
        capabilities: readonly string[] = [],
    ) {
        this.id = nodeId;
        this.name = name;
        this.info = info;
        this.mode = mode;
        this.remoteIp = remoteIp;
        this.capabilities = new Set(capabilities);
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
            remoteIp: this.remoteIp,
        };
    }

    /** Called when a NodeMessage arrives (from a WebSocket or an in-process Agent). */
    receive(msg: NodeMessage): void {
        if (msg.type === "metrics") {
            // A demoted dummy still streams metrics over its own socket; ignore
            // them so the active agent for this machine is the only source.
            if (!this.active) {
                return;
            }
            this.history.push(msg.snapshot);
            if (this.history.length > METRICS_HISTORY_MAX) {
                this.history.splice(0, this.history.length - METRICS_HISTORY_MAX);
            }
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

    private request<T extends NodeMessage>(msg: ControlMessage & { requestId: string }, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(msg.requestId);
                reject(new Error(`Request ${msg.requestId} timed out`));
            }, timeoutMs);

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

    async uploadFile(filePath: string, contentBase64: string): Promise<void> {
        await this.request<Extract<NodeMessage, { type: "uploadFileResponse" }>>({
            type: "uploadFileRequest", requestId: crypto.randomUUID(), path: filePath, contentBase64,
        }, UPLOAD_TIMEOUT_MS);
    }

    async createDir(dirPath: string): Promise<void> {
        await this.request<Extract<NodeMessage, { type: "createDirResponse" }>>({
            type: "createDirRequest", requestId: crypto.randomUUID(), path: dirPath,
        });
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
     * Perform an HTTP request from the host's vantage point — endpoints the
     * control plane can't reach directly (the proxy container's loopback-bound
     * admin API, upstream reachability probes). An agent too old to know the
     * message never replies, so this surfaces as a request timeout there.
     */
    async httpRequest(url: string, method: "GET" | "POST", contentType?: string, body?: string): Promise<NodeHttpResult> {
        if (!this.capabilities.has("httpRequest")) {
            const version = this.info?.agentVersion ?? "unknown version";
            throw new Error(`The agent on ${this.name} (${version}) predates HTTP-request support — update the agent, then retry`);
        }
        const resp = await this.request<Extract<NodeMessage, { type: "httpResponse" }>>({
            type: "httpRequest", requestId: crypto.randomUUID(), url, method, contentType, body,
        });
        return resp.result;
    }

    /**
     * Run a STUN binding request from the host itself, discovering the public IP
     * as seen from that host's network vantage point — distinct from `remoteIp`
     * (the WS connection's source IP as seen by the control plane, which differs
     * per host's NAT) and from the control plane's own STUN check.
     */
    async discoverStun(): Promise<{ ip: string | null }> {
        if (!this.capabilities.has("stun")) {
            const version = this.info?.agentVersion ?? "unknown version";
            throw new Error(`The agent on ${this.name} (${version}) predates STUN support — update the agent, then retry`);
        }
        const resp = await this.request<Extract<NodeMessage, { type: "stunResponse" }>>({
            type: "stunRequest", requestId: crypto.randomUUID(),
        });
        return resp.result;
    }

    /**
     * Probe a candidate install/data directory on the host (writable + exec-capable),
     * backing the setup wizard's live path validation.
     */
    async probeInstallPath(targetPath: string): Promise<InstallProbeResult> {
        const resp = await this.request<Extract<NodeMessage, { type: "probeInstallPathResponse" }>>({
            type: "probeInstallPathRequest", requestId: crypto.randomUUID(), path: targetPath,
        });
        return resp.result;
    }

    /**
     * Promote a live agent to a permanent service, using a durable token to
     * reconnect. mechanism "systemd" installs a unit; "manual" lays down files and
     * returns a startCommand for the operator to wire into their own init system
     * (null for systemd). Only meaningful for remote agents; the embedded agent (the
     * control plane's own host) has no install handler and will reject this.
     */
    async installService(agentToken: string, installDir: string | null, dataDir: string | null, mechanism: InstallMechanism, force?: boolean): Promise<string | null> {
        const resp = await this.request<Extract<NodeMessage, { type: "installServiceResponse" }>>({
            type: "installService", requestId: crypto.randomUUID(), agentToken, installDir, dataDir, mechanism, force,
        });
        return resp.startCommand;
    }

    /**
     * Update an installed agent to `version`: it downloads that binary from the
     * control plane, repoints its symlink, and restarts into it. Only meaningful
     * for remote installed agents; the embedded agent rejects this.
     */
    async updateService(version: string, force?: boolean): Promise<void> {
        await this.request<Extract<NodeMessage, { type: "updateServiceResponse" }>>({
            type: "updateService", requestId: crypto.randomUUID(), version, force,
        });
    }

    /** asUser: OS account the shell runs as (null = the agent's own user, root). */
    async openShell(cols: number, rows: number, asUser: string | null = null): Promise<ShellSession> {
        const sessionId = crypto.randomUUID();
        let dataCb: (data: string) => void = () => { };
        let exitCb: (code: number | null) => void = () => { };

        this.shells.set(sessionId, {
            onData: (data) => dataCb(data),
            onExit: (code) => exitCb(code),
        });

        this.sendControl({ type: "openShell", sessionId, cols, rows, asUser });

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
