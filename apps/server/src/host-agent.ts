import type { AgentMode, ControlMessage, DirEntry, FileContent, HostCapabilityReport, InstallMechanism, InstallProbeResult, MetricsSnapshot, NodeHttpResult, NodeMessage, ResolvedPath, ServerStatus, SystemInfo } from "@central/shared";
import { METRICS_HISTORY_MAX } from "@central/shared";
import { shellCommandFor, shQuote } from "./shell-quote";

const REQUEST_TIMEOUT_MS = 30_000;
/**
 * `uploadFile` alone can carry up to MAX_UPLOAD_BYTES (256MB, as base64 ~341MB) over
 * the same request/response channel as every quick RPC — the fixed 30s ceiling was
 * sized for those, not a few-hundred-MB transfer over a possibly slow link. A flat,
 * generous timeout here beats making every other request wait longer to fail.
 */
const UPLOAD_TIMEOUT_MS = 120_000;
/**
 * Streaming exec times out on *silence*, not on total duration: the timer resets
 * on every chunk, so a `docker pull` that keeps reporting layers can run as long
 * as it needs, while one whose host has genuinely wedged still fails. That's the
 * distinction the fixed REQUEST_TIMEOUT_MS above can't draw — and the reason
 * slow pulls used to die at 30s regardless of progress.
 */
const EXEC_STREAM_IDLE_TIMEOUT_MS = 120_000;

export interface ExecResult {
    stdout: string;
    stderr: string;
    code: number;
}

/** Where and with what environment an argv runs — see {@link HostAgent.run}. */
export interface ExecOptions {
    /** Working directory. Replaces the `cd <dir> && …` prefix a command string needed. */
    cwd?: string;
    /** Extra environment variables, layered over the agent's own environment
     *  (not replacing it). */
    env?: Record<string, string>;
    /**
     * Start the command and let go of it, both streams appended to `logPath`.
     * The result then means "started" — exit code 0 and no output — and whatever
     * the command has to say it says in the log. For work that outlives the
     * request that began it; the caller is responsible for reading the log back.
     */
    detach?: { logPath: string };
}

/** Absolute paths made of characters a glob pattern needs, and nothing a shell
 *  would treat as syntax — the one place a value still reaches an old agent's
 *  shell unquoted (see {@link HostAgent.resolvePaths}). */
const SAFE_GLOB_RE = /^\/[A-Za-z0-9_.\-/*?]*$/;

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
    /** In-flight streaming execs, keyed by requestId — chunk sinks for
     *  {@link execStream}. The terminal `execStreamEnd` goes through `pending`
     *  like any other reply; only the chunks in between need routing here. */
    private readonly execStreams = new Map<string, (stream: "stdout" | "stderr", data: string) => void>();

    /** Post-v0.6.0 message kinds the agent advertised at identify. Agents
     *  ignore unknown message types, so sending one to an agent that didn't
     *  advertise it would die as a silent protocol timeout — check here first. */
    private readonly capabilities: ReadonlySet<string>;

    /** What the *host* can do, as last reported by its agent (at identify, or by
     *  a later `redetectHostCapabilities`). Empty means unknown — an agent too
     *  old to probe — which callers must not conflate with "nothing available".
     *  See {@link HostCapabilityReport}. */
    private hostCapabilities: HostCapabilityReport;
    private hostCapabilitiesAt: number | null;

    constructor(
        private readonly sendControl: (msg: ControlMessage) => void,
        nodeId: string,
        name: string,
        info: SystemInfo | null,
        private readonly onMetrics: (serverId: string, snapshot: MetricsSnapshot) => void,
        mode: AgentMode = "live",
        remoteIp: string | null = null,
        capabilities: readonly string[] = [],
        hostCapabilities: HostCapabilityReport = {},
    ) {
        this.id = nodeId;
        this.name = name;
        this.info = info;
        this.mode = mode;
        this.remoteIp = remoteIp;
        this.capabilities = new Set(capabilities);
        this.hostCapabilities = hostCapabilities;
        this.hostCapabilitiesAt = Object.keys(hostCapabilities).length ? Date.now() : null;
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
            hostCapabilities: Object.keys(this.hostCapabilities).length ? this.hostCapabilities : undefined,
            hostCapabilitiesAt: this.hostCapabilitiesAt ?? undefined,
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
        if (msg.type === "execChunk") {
            this.execStreams.get(msg.requestId)?.(msg.stream, msg.data);
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
        // The streams' own promises were just rejected via `pending` above; this
        // only drops the chunk sinks that would otherwise outlive them.
        this.execStreams.clear();
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

    /**
     * Run a command string through the host's shell.
     *
     * Private, and staying that way: a caller with a string builds it, and
     * building a shell command out of values is where command injection comes
     * from. {@link run} is the way in — it takes an argv, and reaches this only
     * to render one for an agent too old to accept argv directly. The single
     * deliberate shell in the product names it in its own argv (`sh -c <typed
     * command>`, the `cmd` task) rather than arriving here.
     */
    private async exec(command: string): Promise<ExecResult> {
        const resp = await this.request<Extract<NodeMessage, { type: "execResponse" }>>({
            type: "execRequest", requestId: crypto.randomUUID(), command,
        });
        return resp.result;
    }

    /**
     * Run a command, receiving its output through `onChunk` as it appears rather
     * than as one buffered reply at the end. For anything slow enough that its
     * progress is worth watching (image pulls, compose up) — the chunks are what
     * a task's live log is made of.
     *
     * `onChunk` gets raw chunks, which may split a line or carry several; a
     * caller that wants whole lines buffers them itself. The full output is
     * still accumulated and returned, so this is a drop-in for {@link exec}.
     *
     * Falls back to a buffered `exec` against an agent too old to advertise
     * `execStream` — same result, just delivered in one piece at the end (and
     * still bound by the 30s request timeout, as it was before).
     */
    private async execStream(command: string, onChunk: (stream: "stdout" | "stderr", data: string) => void): Promise<ExecResult> {
        if (!this.capabilities.has("execStream")) {
            const res = await this.exec(command);
            if (res.stdout) {
                onChunk("stdout", res.stdout);
            }
            if (res.stderr) {
                onChunk("stderr", res.stderr);
            }
            return res;
        }
        return this.streamExec((requestId) => ({ type: "execStreamRequest", requestId, command }), onChunk);
    }

    /**
     * Run a command with no shell involved: argv[0] is resolved on PATH and the
     * rest reach it as literal arguments. Nothing in them can be read as syntax,
     * so a value that happens to contain `&&`, a quote or a newline is just that
     * value — which is the property {@link exec} can't offer, since it hands
     * `sh -c` a string every caller had to escape correctly on its own.
     *
     * Prefer this for anything the control plane builds. {@link exec} remains for
     * the two places a shell is the point rather than an accident: the `cmd` task
     * (arbitrary operator-typed shell, by permission) and `docker exec … sh -c`,
     * where the shell being invoked is the container's.
     *
     * `opts.cwd`/`opts.env` cover what the shell was doing at the call sites this
     * replaces. There's no redirection because none is needed: stdout and stderr
     * come back separately, which is what merging them with `2>&1` was
     * approximating — and separating them is what lets a caller parse stdout as
     * JSON while a tool writes warnings to stderr.
     *
     * Falls back to a quoted command string against an agent too old to advertise
     * `execArgv` — same result, one more layer of escaping to be right about,
     * which {@link shellCommandFor} is.
     */
    async run(argv: readonly string[], opts?: ExecOptions): Promise<ExecResult> {
        if (argv.length === 0) {
            throw new Error("Cannot run an empty argv");
        }
        if (!this.capabilities.has("execArgv")) {
            const command = shellCommandFor(argv, opts);
            // The shell's own way of letting go of a command, for an agent that
            // can't be asked to do it directly.
            return this.exec(opts?.detach
                ? `nohup ${command} >${shQuote(opts.detach.logPath)} 2>&1 &`
                : command);
        }
        const resp = await this.request<Extract<NodeMessage, { type: "execResponse" }>>({
            type: "execArgvRequest",
            requestId: crypto.randomUUID(),
            argv: [...argv],
            cwd: opts?.cwd,
            env: opts?.env,
            detach: opts?.detach,
        });
        return resp.result;
    }

    /** Streaming {@link run}: {@link execStream}'s live output with {@link run}'s
     *  shell-free argv. The idle timeout and chunk semantics are execStream's. */
    async runStream(
        argv: readonly string[],
        onChunk: (stream: "stdout" | "stderr", data: string) => void,
        opts?: ExecOptions,
    ): Promise<ExecResult> {
        if (argv.length === 0) {
            throw new Error("Cannot run an empty argv");
        }
        if (!this.capabilities.has("execArgv")) {
            return this.execStream(shellCommandFor(argv, opts), onChunk);
        }
        return this.streamExec(
            (requestId) => ({ type: "execArgvStreamRequest", requestId, argv: [...argv], cwd: opts?.cwd, env: opts?.env }),
            onChunk,
        );
    }

    /** The shared half of {@link execStream} and {@link runStream}: route chunks,
     *  time out on silence, and resolve once the exit code arrives. `request`
     *  builds the message to send for the requestId this allocates. */
    private async streamExec(
        request: (requestId: string) => ControlMessage,
        onChunk: (stream: "stdout" | "stderr", data: string) => void,
    ): Promise<ExecResult> {
        const requestId = crypto.randomUUID();
        const stdout: string[] = [];
        const stderr: string[] = [];

        const end = await new Promise<Extract<NodeMessage, { type: "execStreamEnd" }>>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const cleanup = () => {
                clearTimeout(timer);
                this.execStreams.delete(requestId);
            };
            const arm = () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    this.pending.delete(requestId);
                    cleanup();
                    reject(new Error(`Command produced no output for ${Math.round(EXEC_STREAM_IDLE_TIMEOUT_MS / 1000)}s and was abandoned`));
                }, EXEC_STREAM_IDLE_TIMEOUT_MS);
            };

            this.execStreams.set(requestId, (stream, data) => {
                arm(); // output is proof of life
                (stream === "stderr" ? stderr : stdout).push(data);
                onChunk(stream, data);
            });
            this.pending.set(requestId, {
                resolve: (msg) => { cleanup(); resolve(msg as Extract<NodeMessage, { type: "execStreamEnd" }>); },
                reject: (err) => { cleanup(); reject(err); },
            });
            arm();
            this.sendControl(request(requestId));
        });

        return { stdout: stdout.join(""), stderr: stderr.join(""), code: end.code };
    }

    /**
     * Expand glob patterns on the host and follow each match to its real path.
     * Only `*` and `?`, only in the last segment. Ordered by pattern, sorted
     * within each, deduplicated by path.
     *
     * Falls back to the shell loop this replaces against an agent too old to
     * advertise `resolvePaths` — which is why the patterns are shape-checked:
     * they can't be quoted on that path without stopping the glob from
     * expanding, so they have to be safe unquoted.
     */
    async resolvePaths(patterns: readonly string[]): Promise<ResolvedPath[]> {
        for (const pattern of patterns) {
            if (!SAFE_GLOB_RE.test(pattern)) {
                throw new Error(`Invalid path pattern: ${JSON.stringify(pattern)}`);
            }
        }
        if (!this.capabilities.has("resolvePaths")) {
            const loop = `for p in ${patterns.join(" ")}; do [ -e "$p" ] || continue;`
                + ` printf '%s\\t%s\\n' "$p" "$(readlink -f "$p" 2>/dev/null || echo "$p")"; done`;
            const res = await this.exec(loop);
            return res.stdout.split("\n").flatMap((line) => {
                const tab = line.indexOf("\t");
                return tab === -1 ? [] : [{ path: line.slice(0, tab), realPath: line.slice(tab + 1).trim() }];
            });
        }
        const resp = await this.request<Extract<NodeMessage, { type: "resolvePathsResponse" }>>({
            type: "resolvePathsRequest", requestId: crypto.randomUUID(), patterns: [...patterns],
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

    /** Last reported host capabilities. Empty when the agent never reported —
     *  unknown, not "none". */
    hostCapabilityReport(): HostCapabilityReport {
        return this.hostCapabilities;
    }

    /**
     * Ask the agent to re-run its host capability probes and cache the result.
     *
     * Probes already run unprompted on every connect, so this is for the case a
     * reconnect would otherwise be needed to notice: the operator installed ZFS
     * (or started dockerd) on a host whose agent has been connected for days.
     */
    async redetectHostCapabilities(): Promise<HostCapabilityReport> {
        if (!this.capabilities.has("hostCapabilities")) {
            const version = this.info?.agentVersion ?? "unknown version";
            throw new Error(`The agent on ${this.name} (${version}) predates host capability probing — update the agent, then retry`);
        }
        const resp = await this.request<Extract<NodeMessage, { type: "hostCapabilitiesResponse" }>>({
            type: "hostCapabilitiesRequest", requestId: crypto.randomUUID(),
        });
        this.hostCapabilities = resp.report;
        this.hostCapabilitiesAt = Date.now();
        return resp.report;
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

    /** asUser: OS account the shell runs as (null = the agent's own user, root).
     *  command: run this instead of a login/runuser shell (see the protocol
     *  doc comment) — ignores asUser when set.
     *
     *  Impersonation is refused outright against an agent that doesn't advertise
     *  `shellAsUser`: it would ignore the field and hand back a **root** shell,
     *  so the one thing an unsupported request must not do here is succeed. */
    async openShell(cols: number, rows: number, asUser: string | null = null, command?: string): Promise<ShellSession> {
        if (asUser !== null && !command && !this.capabilities.has("shellAsUser")) {
            const version = this.info?.agentVersion ?? "unknown version";
            throw new Error(`The agent on ${this.name} (${version}) predates per-user shells and would open a root shell instead — update the agent, then retry`);
        }
        const sessionId = crypto.randomUUID();
        let dataCb: (data: string) => void = () => { };
        let exitCb: (code: number | null) => void = () => { };

        this.shells.set(sessionId, {
            onData: (data) => dataCb(data),
            onExit: (code) => exitCb(code),
        });

        this.sendControl({ type: "openShell", sessionId, cols, rows, asUser, command });

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
