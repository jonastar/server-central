import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ControlMessage, DirEntry, DirEntryType, FileContent, InstallMechanism, MetricsSnapshot, NodeMessage, SystemInfo } from "@central/shared";
import { AGENT_VERSION, MetricsCollector } from "@central/shared";
import { probeDir } from "./mounts";

export { resolveMachineId } from "./machine-id";

/** Default location for the agent binary (versioned binaries + stable symlink). */
export const DEFAULT_INSTALL_DIR = "/usr/local/bin";
/** Default location for the cert, config, manifest, and exec scratch / state. */
export const DEFAULT_DATA_DIR = "/var/lib/sc-agent";

export interface AgentTransport {
    send(msg: NodeMessage): void;
}

const METRICS_INTERVAL_MS = 5_000;
const HISTORY_MAX = 720;
const MAX_FILE_BYTES = 1024 * 1024;
/** Images can be larger than text files since they're previewed, not edited. */
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
/** Upload cap — kept within the control plane's request timeout and body limits. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

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
        private readonly onInstallService?: (agentToken: string, installDir: string | null, dataDir: string | null, mechanism: InstallMechanism) => Promise<{ startCommand: string | null }>,
        /** Performs the self-update to `version` when the control plane requests
         *  it. Absent for the embedded agent, which ships with the control plane. */
        private readonly onUpdateService?: (version: string) => Promise<void>,
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

            case "execRequest": {
                const result = await this.runExec(msg.command).catch((e) => ({
                    stdout: "", stderr: String(e), code: 1,
                }));
                this.transport.send({ type: "execResponse", requestId: msg.requestId, result });
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
                    const shell = await this.runOpenShell(msg.sessionId, msg.cols, msg.rows);
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
                    const { startCommand } = await this.onInstallService(msg.agentToken, msg.installDir, msg.dataDir, msg.mechanism);
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
                    await this.onUpdateService(msg.version);
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
        const proc = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        return { stdout, stderr, code };
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

    private async runOpenShell(sessionId: string, cols: number, rows: number): Promise<ActiveShell> {
        const decoder = new TextDecoder();

        const proc = Bun.spawn([process.env.SHELL || "bash", "-l"], {
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
