import type { AgentMode, DirEntry, FileContent, HostCapabilityReport, InstallMechanism, InstallProbeResult, MetricsSnapshot, SystemInfo } from "./index";

export interface NodeExecResult {
    stdout: string;
    stderr: string;
    code: number;
}

/** Response to an httpRequest — the status and (size-capped) body of an HTTP
 *  request the agent performed from its host. Network-level failures come back
 *  as a protocol `error` message instead, like other request kinds. */
/** A path a glob matched, with the symlink chain followed to its real target
 *  (`/dev/disk/by-id/ata-X` → `/dev/sda`). Equal to `path` when it isn't a link. */
export interface ResolvedPath {
    path: string;
    realPath: string;
}

export interface NodeHttpResult {
    status: number;
    body: string;
}

// ---- Node → Control ----------------------------------------------------------

export type NodeMessage =
    // capabilities: post-v0.6.0 message kinds this agent handles (see
    // AGENT_CAPABILITIES). Absent from older agents — treated as none.
    // hostCapabilities: what this *machine* can do, probed by the agent before it
    // connects. Rides along on identify rather than costing a round trip after
    // it, so the control plane knows before it even acknowledges — no window
    // where the UI has to guess. Absent from older agents: treated as unknown.
    | { type: "identify"; token: string; info: SystemInfo; machineId: string; mode: AgentMode; capabilities?: string[]; hostCapabilities?: HostCapabilityReport }
    | { type: "metrics"; snapshot: MetricsSnapshot }
    | { type: "execResponse"; requestId: string; result: NodeExecResult }
    // Output of an execStreamRequest as it appears, then one final message with
    // the exit code. `data` is a raw chunk, not a line: it can split a line in
    // half or carry several, so a consumer that wants lines buffers them itself.
    | { type: "execChunk"; requestId: string; stream: "stdout" | "stderr"; data: string }
    | { type: "execStreamEnd"; requestId: string; code: number }
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
    | { type: "stunResponse"; requestId: string; result: { ip: string | null } }
    | { type: "probeInstallPathResponse"; requestId: string; result: InstallProbeResult }
    | { type: "installServiceResponse"; requestId: string; startCommand: string | null }
    | { type: "updateServiceResponse"; requestId: string }
    | { type: "hostCapabilitiesResponse"; requestId: string; report: HostCapabilityReport }
    | { type: "resolvePathsResponse"; requestId: string; result: ResolvedPath[] }
    // Reply to a control-plane `ping`. The control plane doesn't need it for
    // liveness (metrics already flow every 5s) — it exists so the exchange is a
    // real round trip, and older control planes ignore it (no requestId).
    | { type: "pong" }
    | { type: "error"; requestId?: string; message: string };

// ---- Control → Node ----------------------------------------------------------

export type ControlMessage =
    | { type: "acknowledged"; nodeId: string; active: boolean }
    | { type: "execRequest"; requestId: string; command: string }
    // Same as execRequest, but the agent forwards output as it appears rather
    // than buffering it into one reply at the end. Two things depend on that: a
    // task's log streams while the command runs (docker pull), and the control
    // plane can time the request out on *silence* instead of on total duration,
    // which is what the 30s execRequest ceiling really measures. Sent only to
    // agents advertising the "execStream" capability; older ones get a buffered
    // execRequest instead (see HostAgent.execStream).
    | { type: "execStreamRequest"; requestId: string; command: string }
    // Run a command with no shell involved: argv[0] is resolved on PATH and the
    // rest are handed to it as literal arguments, so nothing in them can be read
    // as syntax. This is the form every control-plane-built command should use —
    // `execRequest` composes a string that `sh -c` then re-parses, which puts the
    // burden of escaping on every call site that interpolates a value.
    //
    // What the shell was doing at those call sites is covered by the fields here:
    // `cwd` replaces `cd <dir> && …`, `env` replaces a `K=v …` prefix (merged over
    // the agent's own environment, not replacing it). Redirection has no
    // equivalent and needs none — stdout and stderr come back separately in the
    // reply, which is what `2>&1` was approximating.
    //
    // Replies are the same messages `execRequest`/`execStreamRequest` get
    // (`execResponse`, and `execChunk` + `execStreamEnd`) — this changes how a
    // command is described, not how its output comes back. Sent only to agents
    // advertising the "execArgv" capability; for older ones the control plane
    // renders the argv into a properly quoted command string and falls back to
    // `execRequest` (see HostAgent.run).
    //
    // `detach` is the last thing the shell was doing that argv had no answer for:
    // `nohup … >log 2>&1 &`. The agent starts the command with both its streams
    // pointed at `logPath`, lets go of it, and replies immediately — the reply
    // means "started", not "finished". For work that outlives the request and
    // reports through a file rather than a result (the proxy bring-up, whose
    // image pull can take minutes). It needs no capability of its own: it
    // arrived with `execArgv`, so any agent that handles the message handles the
    // field.
    | { type: "execArgvRequest"; requestId: string; argv: string[]; cwd?: string; env?: Record<string, string>; detach?: { logPath: string } }
    | { type: "execArgvStreamRequest"; requestId: string; argv: string[]; cwd?: string; env?: Record<string, string> }
    // Expand shell-style globs on the host and follow each match to its real
    // path — what `for f in /dev/disk/by-id/*; do readlink -f "$f"; done` was
    // for. Only `*` and `?` are meaningful, and only in the last segment.
    // Sent only to agents advertising "resolvePaths"; older ones get the shell
    // loop instead (see HostAgent.resolvePaths).
    | { type: "resolvePathsRequest"; requestId: string; patterns: string[] }
    | { type: "listDirRequest"; requestId: string; path: string }
    | { type: "readFileRequest"; requestId: string; path: string }
    | { type: "writeFileRequest"; requestId: string; path: string; content: string }
    | { type: "uploadFileRequest"; requestId: string; path: string; contentBase64: string }
    | { type: "createDirRequest"; requestId: string; path: string }
    | { type: "deletePathRequest"; requestId: string; path: string }
    | { type: "renamePathRequest"; requestId: string; from: string; to: string }
    // asUser: OS account to run the shell as (via runuser/su; the agent runs as
    // root). Null/absent means the agent's own user — the pre-mapping behavior.
    // Sent with a non-null value only to agents advertising the "shellAsUser"
    // capability: an agent predating it ignores the field and opens the root
    // shell instead, which is the one failure mode impersonation can't have.
    // command: run this shell command in the PTY instead of a login/runuser
    // shell — used for "terminal into a container" (`docker exec -it …`).
    // Built and validated by the control plane exactly like execRequest's
    // command; the agent just runs it (via `sh -c`, no further parsing).
    // Ignores asUser when set — exec'ing into a container is its own identity
    // boundary, not a host OS user.
    | { type: "openShell"; sessionId: string; cols: number; rows: number; asUser?: string | null; command?: string }
    | { type: "shellInput"; sessionId: string; data: string }
    | { type: "shellResize"; sessionId: string; cols: number; rows: number }
    | { type: "closeShell"; sessionId: string }
    // Perform an HTTP request from the agent's host and return status + body.
    // Exists for endpoints only reachable from that host's vantage point — the
    // proxy container's loopback-bound admin API, upstream reachability probes.
    // Grants nothing exec doesn't already; older agents ignore it (times out).
    | { type: "httpRequest"; requestId: string; url: string; method: "GET" | "POST"; contentType?: string; body?: string }
    // Ask the agent to run its own STUN binding request, discovering the public
    // IP as seen from that host's network vantage point (distinct from the
    // control plane's own STUN check, and from remoteIp — the WS source IP as
    // seen by the control plane, which is NATed differently per host).
    | { type: "stunRequest"; requestId: string }
    // Probe a candidate install/data dir (writable + exec-capable) for the setup wizard.
    | { type: "probeInstallPathRequest"; requestId: string; path: string }
    // Ask a live agent to install itself as a permanent service. The agentToken is a
    // durable credential the installed service uses to reconnect. installDir (binary)
    // and dataDir (cert/config/state) are null to use the agent defaults. mechanism
    // "systemd" writes a unit; "manual" lays down files and replies with a startCommand.
    // force bypasses the "already installed" refusal, overwriting the existing
    // config/cert/binaries — for repairing a broken/partial prior install.
    | { type: "installService"; requestId: string; agentToken: string; installDir: string | null; dataDir: string | null; mechanism: InstallMechanism; force?: boolean }
    // Ask an installed agent to update itself to `version`: download that binary
    // from the control plane, repoint its symlink, and restart into it. force
    // bypasses the agent's own "already running this version" refusal.
    | { type: "updateService"; requestId: string; version: string; force?: boolean }
    // Re-run the host capability probes and report fresh results. Sent only to
    // agents advertising the "hostCapabilities" protocol capability; older ones
    // would never reply and the request would die as a protocol timeout.
    | { type: "hostCapabilitiesRequest"; requestId: string }
    // Periodic liveness beat, sent only to agents advertising the "heartbeat"
    // capability. The agent replies `pong` and, more importantly, treats a
    // missing beat as a dead link: TCP alone can leave a half-open socket the
    // agent happily writes into for many minutes (NAT eviction, gateway reboot),
    // during which it never reconnects. See HEARTBEAT_* in agent-cli.ts.
    | { type: "ping" };