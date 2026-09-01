import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ControlMessage, DirEntry, DirEntryType, FileContent, InstallMechanism, MetricsSnapshot, NodeMessage, SystemInfo } from "@central/shared";
import { AGENT_VERSION, MAX_UPLOAD_BYTES, METRICS_HISTORY_MAX, MetricsCollector } from "@central/shared";
import { probeDir } from "./mounts";
import { probeHostCapabilities } from "./host-capabilities";
import { discoverWanIp } from "../stun";

export { resolveMachineId } from "./machine-id";

/** Default location for the agent binary (versioned binaries + stable symlink). */
export const DEFAULT_INSTALL_DIR = "/usr/local/bin";
/** Default location for the cert, config, manifest, and exec scratch / state. */
export const DEFAULT_DATA_DIR = "/var/lib/sc-agent";

export interface AgentTransport {
    send(msg: NodeMessage): void;
}

const METRICS_INTERVAL_MS = 5_000;
const HISTORY_MAX = METRICS_HISTORY_MAX;
const MAX_FILE_BYTES = 1024 * 1024;
/** Images can be larger than text files since they're previewed, not edited. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/** Recognized image extensions → MIME type, for in-browser preview. */
const IMAGE_MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".avif": "image/avif",
};

function normalizePath(p: string): string {
    return path.resolve("/", p || "/");
}

/** Spawn an argv directly — no shell, so nothing in the arguments is parsed as
 *  syntax. `env` layers over the agent's own environment rather than replacing
 *  it: a caller adding one variable still wants PATH. */
function spawnArgv(argv: string[], cwd?: string, env?: Record<string, string>) {
    return Bun.spawn(argv, {
        stdout: "pipe",
        stderr: "pipe",
        cwd,
        env: env ? { ...process.env, ...env } : undefined,
    });
}

/**
 * Why a spawn never started. Bun reports every such failure as a posix_spawn
 * error naming the binary, which points at the wrong thing when the real problem
 * is the working directory — the common case being a compose stack whose folder
 * has been deleted out from under it, where "posix_spawn 'docker'" reads as
 * "docker isn't installed".
 */
async function spawnFailure(cwd: string | undefined, e: unknown): Promise<string> {
    if (cwd !== undefined) {
        const missing = await fs.stat(cwd).then(() => false, () => true);
        if (missing) {
            return `Working directory ${cwd} is unavailable`;
        }
    }
    return String(e);
}

/** Shell-style wildcards, as a matcher for one path segment. Only `*` and `?`
 *  are meaningful — everything else in the pattern is literal, including the
 *  regex metacharacters a device path is full of (`.`, `+`). */
function segmentMatcher(segment: string): RegExp {
    const escaped = segment
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]");
    return new RegExp(`^${escaped}$`);
}

/**
 * Expand glob patterns and follow each match to its real path — the agent-side
 * answer to `for f in /dev/disk/by-id/*; do readlink -f "$f"; done`.
 *
 * Only the last segment may be a pattern, which is all either caller needs
 * (`/dev/ttyACM*`, `/dev/serial/by-id/*`, a bare `/dev/net/tun`) and keeps this
 * from becoming a directory walker. Matches come back in pattern order, sorted
 * within each pattern, deduplicated by path: `listHostDevices` relies on that
 * order to prefer a stable by-id name over the `/dev/ttyACM0` it points at.
 *
 * A pattern whose directory is missing contributes nothing rather than failing —
 * hosts without `/dev/serial` are the common case, not an error.
 */
async function runResolvePaths(patterns: string[]): Promise<{ path: string; realPath: string }[]> {
    const out: { path: string; realPath: string }[] = [];
    const seen = new Set<string>();

    const add = async (p: string): Promise<void> => {
        if (seen.has(p)) {
            return;
        }
        seen.add(p);
        // realpath fails on a dangling symlink; the path itself is still the
        // answer for anything that only needs the name.
        const realPath = await fs.realpath(p).catch(() => p);
        out.push({ path: p, realPath });
    };

    for (const pattern of patterns) {
        const slash = pattern.lastIndexOf("/");
        const dir = pattern.slice(0, slash) || "/";
        const leaf = pattern.slice(slash + 1);

        if (!leaf.includes("*") && !leaf.includes("?")) {
            if (await fs.stat(pattern).then(() => true, () => false)) {
                await add(pattern);
            }
            continue;
        }

        const names = await fs.readdir(dir).catch((): string[] => []);
        const match = segmentMatcher(leaf);
        for (const name of names.filter((n) => match.test(n)).sort()) {
            await add(`${dir}/${name}`);
        }
    }
    return out;
}

/** Drain a spawned process's pipes and wait for it to exit. */
async function collectProc(proc: {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
}): Promise<{ stdout: string; stderr: string; code: number }> {
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, code };
}

function permString(mode: number): string {
    const flags = ["r", "w", "x"];
    let out = "";
    for (let shift = 8; shift >= 0; shift--) {
        out += mode & (1 << shift) ? flags[(8 - shift) % 3] : "-";
    }
    return out;
}

async function readOsRelease(): Promise<string> {
    try {
        const text = await fs.readFile("/etc/os-release", "utf8");
        const m = text.match(/^PRETTY_NAME="?([^"\n]*)"?$/m);
        if (m?.[1]) {
            return m[1];
        }
    } catch { /* fall through */ }
    return `${os.type()} ${os.release()}`;
}

function primaryIp(): string {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces ?? []) {
            if (!iface.internal && iface.family === "IPv4") {
                return iface.address;
            }
        }
    }
    return "127.0.0.1";
}

export async function collectSystemInfo(): Promise<SystemInfo> {
    return {
        hostname: os.hostname(),
        os: await readOsRelease(),
        kernel: os.release(),
        arch: os.arch(),
        primaryIp: primaryIp(),
        cpuModel: os.cpus()[0]?.model ?? "",
        cpuCores: os.cpus().length,
        uptimeSeconds: os.uptime(),
        capturedAt: Date.now(),
        agentVersion: AGENT_VERSION,
        install: await collectInstallInfo(),
    };
}

/** Whether the default install + data dirs are usable as-is; if not (read-only OS
 *  root or noexec mount, e.g. TrueNAS), the setup wizard requires custom paths. */
async function collectInstallInfo(): Promise<SystemInfo["install"]> {
    const [installProbe, dataProbe] = await Promise.all([
        probeDir(DEFAULT_INSTALL_DIR),
        probeDir(DEFAULT_DATA_DIR),
    ]);
    const usable = (p: { writable: boolean; execCapable: boolean }) => p.writable && p.execCapable;
    return {
        defaultInstallDir: DEFAULT_INSTALL_DIR,
        defaultDataDir: DEFAULT_DATA_DIR,
        defaultsUsable: usable(installProbe) && usable(dataProbe),
    };
}

interface ActiveShell {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    close(): void;
}

/**
 * Runs on a managed host — both embedded (control plane, via `server --agent`'s
 * in-process transport) and remote (the agent binary, via a WebSocket transport).
 * Receives ControlMessages, executes operations, and sends NodeMessages via the
 * transport. The transport is the only difference between embedded and remote.
 */
export class Agent {
    readonly isEmbedded: boolean;
    readonly history: MetricsSnapshot[] = [];

    private readonly collector = new MetricsCollector();
    private metricsTimer: ReturnType<typeof setInterval> | null = null;
    private readonly shells = new Map<string, ActiveShell>();

    constructor(
        private readonly transport: AgentTransport,
        isEmbedded = false,
        /** Performs the self-install when the control plane requests it, returning a
         *  startCommand for the manual mechanism (null for systemd). Absent for the
         *  embedded agent, which cannot install itself. */
        private readonly onInstallService?: (agentToken: string, installDir: string | null, dataDir: string | null, mechanism: InstallMechanism, force?: boolean) => Promise<{ startCommand: string | null }>,
        /** Performs the self-update to `version` when the control plane requests
         *  it. Absent for the embedded agent, which ships with the control plane. */
        private readonly onUpdateService?: (version: string, force?: boolean) => Promise<void>,
    ) {
        this.isEmbedded = isEmbedded;
    }

    startMetrics(): void {
        void this.sampleMetrics();
        this.metricsTimer = setInterval(() => void this.sampleMetrics(), METRICS_INTERVAL_MS);
    }

    stopMetrics(): void {
        if (this.metricsTimer) {
            clearInterval(this.metricsTimer);
        }
        this.metricsTimer = null;
    }

    async onMessage(msg: ControlMessage): Promise<void> {
        switch (msg.type) {
            case "acknowledged":
                break;

            case "hostCapabilitiesRequest": {
                this.transport.send({
                    type: "hostCapabilitiesResponse",
                    requestId: msg.requestId,
                    report: await probeHostCapabilities(),
                });
                break;
            }

            case "ping":
                // The reply is for symmetry; the beat's real job is on the receiving
                // side — the connect loop's watchdog treats its absence as a dead link.
                this.transport.send({ type: "pong" });
                break;

            case "execRequest": {
                const result = await this.runExec(msg.command).catch((e) => ({
                    stdout: "", stderr: String(e), code: 1,
                }));
                this.transport.send({ type: "execResponse", requestId: msg.requestId, result });
                break;
            }

            case "execStreamRequest": {
                // Deliberately not awaited: chunks flow from inside runExecStream
                // as the command produces them, and the message loop must stay
                // free to handle everything else meanwhile.
                void this.runExecStream(msg.requestId, msg.command);
                break;
            }

            case "execArgvRequest": {
                const result = msg.detach
                    ? await this.runDetached(msg.argv, msg.detach.logPath, msg.cwd, msg.env)
                    : await this.runExecArgv(msg.argv, msg.cwd, msg.env);
                this.transport.send({ type: "execResponse", requestId: msg.requestId, result });
                break;
            }

            case "execArgvStreamRequest": {
                // Not awaited, for the same reason as execStreamRequest above.
                void this.runExecStream(msg.requestId, msg.argv, msg.cwd, msg.env);
                break;
            }

            case "resolvePathsRequest": {
                try {
                    const result = await runResolvePaths(msg.patterns);
                    this.transport.send({ type: "resolvePathsResponse", requestId: msg.requestId, result });
                } catch (e) {
                    this.transport.send({ type: "error", requestId: msg.requestId, message: String(e) });
                }
                break;
            }

            case "listDirRequest": {
                try {
                    const result = await this.runListDir(msg.path);
                    this.transport.send({ type: "listDirResponse", requestId: msg.requestId, result });
                } catch (e) {
                    this.transport.send({ type: "error", requestId: msg.requestId, message: String(e) });
                }
                break;
            }

            case "readFileRequest": {
                try {
                    const result = await this.runReadFile(msg.path);
                    this.transport.send({ type: "readFileResponse", requestId: msg.requestId, result });
                } catch (e) {
                    this.transport.send({ type: "error", requestId: msg.requestId, message: String(e) });
                }
                break;
            }

            case "writeFileRequest": {
                try {
                    await this.runWriteFile(msg.path, msg.content);
                    this.transport.send({ type: "writeFileResponse", requestId: msg.requestId });
                } catch (e) {
                    this.transport.send({ type: "error", requestId: msg.requestId, message: String(e) });
                }
                break;
            }

            case "uploadFileRequest": {
                try {
                    await this.runUploadFile(msg.path, msg.contentBase64);
                    this.transport.send({ type: "uploadFileResponse", requestId: msg.requestId });
                } catch (e) {
                    this.transport.send({ type: "error", requestId: msg.requestId, message: String(e) });
                }
                break;
            }

            case "createDirRequest": {
                try {
                    await this.runCreateDir(msg.path);
                    this.transport.send({ type: "createDirResponse", requestId: msg.requestId });
                } catch (e) {
                    this.transport.send({ type: "error", requestId: msg.requestId, message: String(e) });
                }
                break;
            }

            case "deletePathRequest": {
                try {
                    await this.runDeletePath(msg.path);
                    this.transport.send({ type: "deletePathResponse", requestId: msg.requestId });
                } catch (e) {
                    this.transport.send({ type: "error", requestId: msg.requestId, message: String(e) });
                }
                break;
            }

            case "renamePathRequest": {
                try {
                    await this.runRenamePath(msg.from, msg.to);
                    this.transport.send({ type: "renameResponse", requestId: msg.requestId });
                } catch (e) {
                    this.transport.send({ type: "error", requestId: msg.requestId, message: String(e) });
                }
                break;
            }

            case "openShell": {
                try {
                    const shell = await this.runOpenShell(msg.sessionId, msg.cols, msg.rows, msg.asUser ?? null, msg.command);
                    this.shells.set(msg.sessionId, shell);
                } catch (e) {
                    this.transport.send({ type: "error", message: String(e) });
                }
                break;
            }

            case "shellInput":
                this.shells.get(msg.sessionId)?.write(msg.data);
                break;

            case "shellResize":
                this.shells.get(msg.sessionId)?.resize(msg.cols, msg.rows);
                break;

            case "closeShell":
                this.shells.get(msg.sessionId)?.close();
                this.shells.delete(msg.sessionId);
                break;

            case "httpRequest": {
                try {
                    const result = await this.runHttpRequest(msg.url, msg.method, msg.contentType, msg.body);
                    this.transport.send({ type: "httpResponse", requestId: msg.requestId, result });
                } catch (e) {
                    this.transport.send({ type: "error", requestId: msg.requestId, message: String(e) });
                }
                break;
            }

            case "stunRequest": {
                try {
                    const ip = await discoverWanIp();
                    this.transport.send({ type: "stunResponse", requestId: msg.requestId, result: { ip } });
                } catch (e) {
                    this.transport.send({ type: "error", requestId: msg.requestId, message: String(e) });
                }
                break;
            }

            case "probeInstallPathRequest": {
                try {
                    const result = await probeDir(msg.path);
                    this.transport.send({ type: "probeInstallPathResponse", requestId: msg.requestId, result });
                } catch (e) {
                    this.transport.send({ type: "error", requestId: msg.requestId, message: String(e) });
                }
                break;
            }

            case "installService": {
                try {
                    if (!this.onInstallService) {
                        throw new Error("This agent cannot install itself");
                    }
                    const { startCommand } = await this.onInstallService(msg.agentToken, msg.installDir, msg.dataDir, msg.mechanism, msg.force);
                    this.transport.send({ type: "installServiceResponse", requestId: msg.requestId, startCommand });
                } catch (e) {
                    this.transport.send({ type: "error", requestId: msg.requestId, message: String(e) });
                }
                break;
            }

            case "updateService": {
                try {
                    console.log(`[update] received updateService request ${msg.requestId} for version ${msg.version}`);
                    if (!this.onUpdateService) {
                        throw new Error("This agent cannot update itself");
                    }
                    await this.onUpdateService(msg.version, msg.force);
                    this.transport.send({ type: "updateServiceResponse", requestId: msg.requestId });
                } catch (e) {
                    console.error(`[update] updateService request ${msg.requestId} failed: ${String(e)}`);
                    this.transport.send({ type: "error", requestId: msg.requestId, message: String(e) });
                }
                break;
            }
        }
    }

    // ---- Metrics -----------------------------------------------------------------

    private async sampleMetrics(): Promise<void> {
        try {
            const [stat, mem, net, disk, df] = await Promise.all([
                fs.readFile("/proc/stat", "utf8"),
                fs.readFile("/proc/meminfo", "utf8"),
                fs.readFile("/proc/net/dev", "utf8"),
                fs.readFile("/proc/diskstats", "utf8"),
                this.runExec("df -kP 2>/dev/null").then((r) => r.stdout),
            ]);
            const snapshot = this.collector.ingest({ stat, mem, net, disk, df });
            if (!snapshot) {
                return;
            }
            this.history.push(snapshot);
            if (this.history.length > HISTORY_MAX) {
                this.history.splice(0, this.history.length - HISTORY_MAX);
            }
            this.transport.send({ type: "metrics", snapshot });
        } catch { /* missed tick is fine */ }
    }

    // ---- Runner methods ----------------------------------------------------------

    private async runExec(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
        return collectProc(Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" }));
    }

    /**
     * Shell-free counterpart of {@link runExec}: argv[0] is resolved on PATH and
     * the remaining elements reach it as literal arguments, so no character in
     * them is syntax. See the `execArgvRequest` protocol comment for why that's
     * the form the control plane should be building.
     *
     * A command that can't start (no such binary, unusable cwd) comes back as
     * exit 127 with the reason on stderr rather than as a protocol error: that's
     * what the shell path reports for the same condition, and callers already
     * read a non-zero code as "this didn't work" — the alternative would make an
     * absent `zpool` fail differently depending on the agent's age.
     */
    private async runExecArgv(argv: string[], cwd?: string, env?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
        if (argv.length === 0) {
            return { stdout: "", stderr: "Cannot run an empty argv", code: 127 };
        }
        try {
            return await collectProc(spawnArgv(argv, cwd, env));
        } catch (e) {
            return { stdout: "", stderr: await spawnFailure(cwd, e), code: 127 };
        }
    }

    /**
     * Start a command and let go of it, with both its streams appended to
     * `logPath` — `nohup … >log 2>&1 &` without the shell. The reply says the
     * command *started*: it outlives this request, and whatever it has to report
     * it reports into the log, which the control plane reads later.
     *
     * Both fds point at the same open file, so the two streams interleave in the
     * file exactly as the shell redirect had them.
     */
    private async runDetached(argv: string[], logPath: string, cwd?: string, env?: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
        if (argv.length === 0) {
            return { stdout: "", stderr: "Cannot run an empty argv", code: 127 };
        }
        let log;
        try {
            log = await fs.open(logPath, "w");
        } catch (e) {
            return { stdout: "", stderr: `Cannot write ${logPath}: ${e}`, code: 127 };
        }
        try {
            const proc = Bun.spawn(argv, {
                cwd,
                env: env ? { ...process.env, ...env } : undefined,
                stdin: "ignore",
                stdout: log.fd,
                stderr: log.fd,
            });
            // Nothing here waits for it, and the process must not keep the agent's
            // event loop alive on its own.
            proc.unref();
            return { stdout: "", stderr: "", code: 0 };
        } catch (e) {
            return { stdout: "", stderr: await spawnFailure(cwd, e), code: 127 };
        } finally {
            // The child holds its own duplicate of the descriptor.
            await log.close();
        }
    }

    /**
     * Streaming counterpart of {@link runExec} and {@link runExecArgv} — a string
     * `command` runs under `sh -c`, an argv array spawns directly. Forwards
     * output as the command produces it, then reports the exit code separately.
     * What this buys over the buffered runners is progress on a slow command (a
     * `docker pull`'s per-layer lines reaching the task log while it runs) and a
     * control plane that can time the request out on silence rather than on total
     * duration.
     *
     * Errors go back as a protocol `error` for the requestId, which the control
     * plane already treats as the request failing — a half-streamed command
     * doesn't need a distinct failure shape.
     */
    private async runExecStream(requestId: string, command: string | string[], cwd?: string, env?: Record<string, string>): Promise<void> {
        let proc;
        try {
            proc = Array.isArray(command)
                ? spawnArgv(command, cwd, env)
                : Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
        } catch (e) {
            // Couldn't start at all — reported as output + exit 127 rather than a
            // protocol error, for the reason {@link runExecArgv} gives.
            this.transport.send({ type: "execChunk", requestId, stream: "stderr", data: await spawnFailure(cwd, e) });
            this.transport.send({ type: "execStreamEnd", requestId, code: 127 });
            return;
        }
        try {
            const pump = async (stream: ReadableStream<Uint8Array>, which: "stdout" | "stderr"): Promise<void> => {
                // Streaming decode: a chunk boundary can land mid-UTF-8-sequence,
                // and decoding each buffer independently would corrupt it.
                const decoder = new TextDecoder();
                for await (const buf of stream) {
                    const data = decoder.decode(buf, { stream: true });
                    if (data) {
                        this.transport.send({ type: "execChunk", requestId, stream: which, data });
                    }
                }
                const tail = decoder.decode();
                if (tail) {
                    this.transport.send({ type: "execChunk", requestId, stream: which, data: tail });
                }
            };
            await Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")]);
            this.transport.send({ type: "execStreamEnd", requestId, code: await proc.exited });
        } catch (e) {
            this.transport.send({ type: "error", requestId, message: String(e) });
        }
    }

    /** Timeout under the control plane's 30s request timeout, so a hung server
     *  produces a real error instead of a silent protocol timeout. */
    private static readonly HTTP_TIMEOUT_MS = 25_000;
    private static readonly HTTP_MAX_BODY_BYTES = 1024 * 1024;

    private async runHttpRequest(url: string, method: "GET" | "POST", contentType?: string, body?: string): Promise<{ status: number; body: string }> {
        const res = await fetch(url, {
            method,
            headers: contentType ? { "Content-Type": contentType } : undefined,
            body: body ?? undefined,
            signal: AbortSignal.timeout(Agent.HTTP_TIMEOUT_MS),
        });
        const text = await res.text();
        return {
            status: res.status,
            body: text.length > Agent.HTTP_MAX_BODY_BYTES ? text.slice(0, Agent.HTTP_MAX_BODY_BYTES) : text,
        };
    }

    private async runListDir(dirPath: string): Promise<{ path: string; entries: DirEntry[] }> {
        const target = normalizePath(dirPath);
        const dirents = await fs.readdir(target, { withFileTypes: true });
        const entries = await Promise.all(dirents.map(async (d): Promise<DirEntry> => {
            const type: DirEntryType = d.isSymbolicLink() ? "symlink"
                : d.isDirectory() ? "dir"
                    : d.isFile() ? "file"
                        : "other";
            try {
                const st = await fs.lstat(path.join(target, d.name));
                return { name: d.name, type, sizeBytes: st.size, modifiedAt: st.mtimeMs, permissions: permString(st.mode) };
            } catch {
                return { name: d.name, type, sizeBytes: 0, modifiedAt: 0, permissions: "" };
            }
        }));
        entries.sort((a, b) =>
            a.type === "dir" !== (b.type === "dir") ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
        );
        return { path: target, entries };
    }

    private async runReadFile(filePath: string): Promise<FileContent> {
        const target = normalizePath(filePath);
        const st = await fs.stat(target);
        const mimeType = IMAGE_MIME[path.extname(target).toLowerCase()];

        // Images are sent as base64 for in-browser preview rather than treated as
        // un-openable binary, up to a larger cap than text files.
        if (mimeType && st.size <= MAX_IMAGE_BYTES) {
            const data = await fs.readFile(target);
            return { path: target, content: data.toString("base64"), sizeBytes: st.size, truncated: false, binary: true, encoding: "base64", mimeType };
        }

        const handle = await fs.open(target, "r");
        try {
            const buf = Buffer.alloc(Math.min(st.size, MAX_FILE_BYTES));
            const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
            const data = buf.subarray(0, bytesRead);
            const binary = data.includes(0);
            return { path: target, content: binary ? "" : data.toString("utf8"), sizeBytes: st.size, truncated: st.size > MAX_FILE_BYTES, binary };
        } finally {
            await handle.close();
        }
    }

    private async runWriteFile(filePath: string, content: string): Promise<void> {
        await fs.writeFile(normalizePath(filePath), content, "utf8");
    }

    private async runUploadFile(filePath: string, contentBase64: string): Promise<void> {
        const data = Buffer.from(contentBase64, "base64");
        if (data.length > MAX_UPLOAD_BYTES) {
            throw new Error(`File too large: ${data.length} bytes (max ${MAX_UPLOAD_BYTES})`);
        }
        await fs.writeFile(normalizePath(filePath), data);
    }

    private async runCreateDir(dirPath: string): Promise<void> {
        await fs.mkdir(normalizePath(dirPath), { recursive: true });
    }

    private async runDeletePath(targetPath: string): Promise<void> {
        const target = normalizePath(targetPath);
        if (target === "/") {
            throw new Error("Refusing to delete /");
        }
        await fs.rm(target, { recursive: true });
    }

    private async runRenamePath(from: string, to: string): Promise<void> {
        await fs.rename(normalizePath(from), normalizePath(to));
    }

    /** The argv for a terminal session. Running as another user wraps the login
     *  shell in runuser/su (login mode, so it lands in their home with their
     *  environment); that needs the agent to be root, which the installed agent
     *  always is. A shell as the agent's own user needs no wrapper. */
    private shellArgv(asUser: string | null): string[] {
        if (!asUser || asUser === os.userInfo().username) {
            return [process.env.SHELL || "bash", "-l"];
        }
        // Shape-check the name even though argv can't be shell-injected — runuser
        // option smuggling (e.g. a name starting with "-") is still a thing.
        if (!/^[a-z_][a-z0-9_-]{0,31}\$?$/.test(asUser)) {
            throw new Error(`Invalid system username: ${asUser}`);
        }
        if (os.userInfo().username !== "root") {
            throw new Error(`Agent runs as ${os.userInfo().username} and can't open a shell as ${asUser}`);
        }
        const runuser = Bun.which("runuser");
        return runuser ? [runuser, "-l", asUser] : ["su", "-", asUser];
    }

    private async runOpenShell(sessionId: string, cols: number, rows: number, asUser: string | null, command?: string): Promise<ActiveShell> {
        const decoder = new TextDecoder();
        const argv = command ? ["sh", "-c", command] : this.shellArgv(asUser);

        const proc = Bun.spawn(argv, {
            cwd: os.homedir(),
            env: { ...process.env, TERM: "xterm-256color" },
            terminal: {
                cols,
                rows,
                data: (_term, data) => {
                    this.transport.send({ type: "shellData", sessionId, data: decoder.decode(data, { stream: true }) });
                },
            },
        });

        const terminal = proc.terminal;
        if (!terminal) { proc.kill(); throw new Error("Failed to allocate a PTY"); }

        void proc.exited.then((code) => {
            this.shells.delete(sessionId);
            this.transport.send({ type: "shellExit", sessionId, code });
        });

        return {
            write(data) { terminal.write(data); },
            resize(c, r) { terminal.resize(c, r); },
            close() { try { terminal.close(); } catch { } proc.kill(); },
        };
    }
}
