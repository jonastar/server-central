import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "bun";
import type { MetricsSnapshot, NodeMessage } from "@central/shared";
import type { TlsBundle } from "./tls";
import { HostAgent } from "./host-agent";
import type { Fleet } from "./fleet";
import { readAgentTokens, writeAgentTokens } from "./config";

export const NODE_SERVER_PORT = 4142;

/** Dist directory relative to the server package root. */
const DIST_DIR = path.resolve(import.meta.dir, "../../../dist");

const PLATFORM_BINARY: Record<string, string> = {
    linux: "sc-agent-linux",
    mac: "sc-agent-mac",
    windows: "sc-agent-windows.exe",
};

type NodeWsData = { channel: "node"; connId: string | null };

interface TokenEntry {
    expiresAt: number;
    downloaded: boolean;
}

export class NodeServer {
    private tokens = new Map<string, TokenEntry>();
    private agents = new Map<string, HostAgent>();
    private server: Server<NodeWsData> | null = null;
    private tokenSweep: ReturnType<typeof setInterval> | null = null;
    /** Durable per-machine tokens (machineId → token) for installed agents. */
    private durableTokens: Record<string, string> = {};
    private durableTokenSet = new Set<string>();

    constructor(
        private readonly fleet: Fleet,
        private readonly tls: TlsBundle,
        private readonly lanIp: string,
        private readonly wanIp: string | null,
        private readonly onMetrics: (serverId: string, snapshot: MetricsSnapshot) => void,
        private readonly listenPort: number = NODE_SERVER_PORT,
    ) { }

    /** The port the node server is actually listening on (resolved when listenPort is 0). */
    get port(): number {
        return this.server?.port ?? this.listenPort;
    }

    /** Load persisted durable agent tokens. Call before start(). */
    async init(): Promise<void> {
        this.durableTokens = await readAgentTokens();
        this.durableTokenSet = new Set(Object.values(this.durableTokens));
    }

    /** Issue a fresh enrollment token without wrapping it in an install command. */
    mintToken(): { token: string; expiresAt: number } {
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + 30 * 60 * 1000;
        this.tokens.set(token, { expiresAt, downloaded: false });
        return { token, expiresAt };
    }

    /**
     * Issue (or replace) a durable token for a machine, used by an installed
     * service to reconnect indefinitely. Persisted so it survives restarts.
     */
    async mintAgentToken(machineId: string): Promise<string> {
        const token = crypto.randomUUID();
        this.durableTokens[machineId] = token;
        this.durableTokenSet = new Set(Object.values(this.durableTokens));
        await writeAgentTokens(this.durableTokens);
        return token;
    }

    generateInstallCommand(platform: "linux" | "mac" | "windows", domain: string | null): { command: string; expiresAt: number } {
        const { token, expiresAt } = this.mintToken();

        const externalHost = domain ?? this.wanIp;

        const baseUrl = `https://${this.lanIp}:${NODE_SERVER_PORT}`;
        const controlWs = `wss://${this.lanIp}:${NODE_SERVER_PORT}/node`;
        const altControlWs = externalHost ? `wss://${externalHost}:${NODE_SERVER_PORT}/node` : null;
        const altFlag = altControlWs ? ` --alt-control "${altControlWs}"` : "";

        const pinned = `-k --pinnedpubkey "${this.tls.pin}"`;

        let command: string;
        if (platform === "windows") {
            command =
                `curl.exe ${pinned} -fsSL "${baseUrl}/node-bootstrap/${token}/windows" -o "$env:TEMP\\sc-agent.exe"` +
                `; curl.exe ${pinned} -fsSL "${baseUrl}/node-cert" -o "$env:TEMP\\sc-agent.crt"` +
                `; & "$env:TEMP\\sc-agent.exe" --agent --control "${controlWs}"${altFlag} --token "${token}" --cert "$env:TEMP\\sc-agent.crt"`;
        } else {
            // Run the agent with sudo: it manages the host and, when promoted,
            // installs itself as a (root) systemd service — both need privileges.
            command =
                `curl ${pinned} -fsSL "${baseUrl}/node-bootstrap/${token}/${platform}" -o /tmp/sc-agent` +
                ` && curl ${pinned} -fsSL "${baseUrl}/node-cert" -o /tmp/sc-agent.crt` +
                ` && chmod +x /tmp/sc-agent` +
                ` && sudo /tmp/sc-agent --agent --control "${controlWs}"${altFlag} --token "${token}" --cert /tmp/sc-agent.crt`;
        }

        return { command, expiresAt };
    }

    /** Serve the compiled agent binary for `platform` from dist/. */
    private static binaryResponse(platform: string): Response {
        const binary = PLATFORM_BINARY[platform];
        if (!binary) {
            return new Response("Unknown platform", { status: 400 });
        }
        const binPath = path.join(DIST_DIR, binary);
        try {
            return new Response(Bun.file(binPath), {
                headers: { "Content-Type": "application/octet-stream" },
            });
        } catch {
            return new Response(`Binary not found: build with 'bun run build:agent'`, { status: 404 });
        }
    }

    private validateToken(token: string): boolean {
        // Durable tokens (installed agents) never expire.
        if (this.durableTokenSet.has(token)) {
            return true;
        }
        const entry = this.tokens.get(token);
        if (!entry) {
            return false;
        }
        if (Date.now() > entry.expiresAt) {
            this.tokens.delete(token);
            return false;
        }
        return true;
    }

    start(): void {
        const self = this;

        this.server = Bun.serve<NodeWsData>({
            port: this.listenPort,
            tls: {
                cert: this.tls.certPem,
                key: this.tls.keyPem,
            },
            async fetch(req, serverCtx) {
                const url = new URL(req.url);

                if (req.method === "GET" && url.pathname === "/node-cert") {
                    return new Response(self.tls.certPem, {
                        headers: { "Content-Type": "application/x-pem-file" },
                    });
                }

                const bootstrapMatch = url.pathname.match(/^\/node-bootstrap\/([^/]+)\/([^/]+)$/);
                if (req.method === "GET" && bootstrapMatch) {
                    const [, token, platform] = bootstrapMatch;
                    if (!self.validateToken(token)) {
                        return new Response("Invalid or expired token", { status: 403 });
                    }
                    self.tokens.get(token)!.downloaded = true;
                    return NodeServer.binaryResponse(platform);
                }

                // Binary fetch for an installed agent's self-update — same binaries
                // as bootstrap, but authenticated by the agent's durable token (so
                // it doesn't touch the short-lived enrollment token map).
                const binaryMatch = url.pathname.match(/^\/node-binary\/([^/]+)\/([^/]+)$/);
                if (req.method === "GET" && binaryMatch) {
                    const [, token, platform] = binaryMatch;
                    if (!self.validateToken(token)) {
                        return new Response("Invalid or expired token", { status: 403 });
                    }
                    return NodeServer.binaryResponse(platform);
                }

                if (url.pathname === "/node") {
                    if (serverCtx.upgrade(req, { data: { channel: "node", connId: null } satisfies NodeWsData })) {
                        return undefined as unknown as Response;
                    }
                    return new Response("Upgrade failed", { status: 400 });
                }

                return new Response("Not found", { status: 404 });
            },
            websocket: {
                open(_ws) {
                    // Wait for identify message
                },
                message(ws, message) {
                    let msg: NodeMessage;
                    try {
                        msg = JSON.parse(String(message)) as NodeMessage;
                    } catch {
                        ws.close(1003, "invalid JSON");
                        return;
                    }

                    const connId = ws.data.connId;

                    if (!connId) {
                        if (msg.type !== "identify") {
                            ws.close(1002, "expected identify");
                            return;
                        }
                        if (!self.validateToken(msg.token)) {
                            ws.close(1008, "invalid token");
                            return;
                        }
                        // Route this socket's messages by a per-connection id, but
                        // identify the host (and the fleet entry) by its machine id.
                        const conn = crypto.randomUUID();
                        ws.data.connId = conn;

                        const proxy = new HostAgent(
                            (ctrlMsg) => ws.send(JSON.stringify(ctrlMsg)),
                            msg.machineId,
                            msg.info.hostname,
                            msg.info,
                            self.onMetrics,
                            msg.mode,
                        );
                        self.agents.set(conn, proxy);
                        const active = self.fleet.register(proxy);

                        ws.send(JSON.stringify({ type: "acknowledged", nodeId: msg.machineId, active }));
                        const role = active ? msg.mode : `${msg.mode}, standby`;
                        console.log(`Node connected: ${msg.info.hostname} (${msg.machineId}) [${role}]`);
                        return;
                    }

                    self.agents.get(connId)?.receive(msg);
                },
                close(ws) {
                    const connId = ws.data.connId;
                    if (!connId) {
                        return;
                    }
                    const proxy = self.agents.get(connId);
                    if (proxy) {
                        proxy.disconnect();
                        self.agents.delete(connId);
                        self.fleet.deregister(proxy);
                        console.log(`Node disconnected: ${proxy.name} (${proxy.id})`);
                    }
                },
            },
        });

        console.log(`Node server (HTTPS/WSS) listening on :${this.port}`);

        this.tokenSweep = setInterval(() => {
            const now = Date.now();
            for (const [token, entry] of self.tokens) {
                if (now > entry.expiresAt) {
                    self.tokens.delete(token);
                }
            }
        }, 5 * 60 * 1000);
        // Don't keep the process alive on this timer alone (matters for tests).
        this.tokenSweep.unref?.();
    }

    /** Stop listening and clear timers. Primarily for tests. */
    stop(): void {
        if (this.tokenSweep) {
            clearInterval(this.tokenSweep);
        }
        this.tokenSweep = null;
        this.server?.stop(true);
        this.server = null;
    }
}

function primaryLanIp(): string {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces ?? []) {
            if (!iface.internal && iface.family === "IPv4") {
                return iface.address;
            }
        }
    }
    return "127.0.0.1";
}

export async function startNodeServer(
    fleet: Fleet,
    tls: TlsBundle,
    wanIp: string | null,
    onMetrics: (serverId: string, snapshot: MetricsSnapshot) => void,
): Promise<NodeServer> {
    const server = new NodeServer(fleet, tls, primaryLanIp(), wanIp, onMetrics);
    await server.init();
    server.start();
    return server;
}
