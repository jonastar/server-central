import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerWebSocket } from "bun";
import type { MetricsSnapshot, NodeMessage } from "@central/shared";
import type { TlsBundle } from "./tls";
import { NodeProxy } from "./node-proxy";
import type { Fleet } from "./fleet";

export const NODE_SERVER_PORT = 4142;

/** Dist directory relative to the server package root. */
const DIST_DIR = path.resolve(import.meta.dir, "../../../dist");

const PLATFORM_BINARY: Record<string, string> = {
    linux: "sc-agent-linux",
    mac: "sc-agent-mac",
    windows: "sc-agent-windows.exe",
};

type NodeWsData = { channel: "node"; nodeId: string | null };

interface TokenEntry {
    expiresAt: number;
    downloaded: boolean;
}

export class NodeServer {
    private tokens = new Map<string, TokenEntry>();
    private agents = new Map<string, NodeProxy>();

    constructor(
        private readonly fleet: Fleet,
        private readonly tls: TlsBundle,
        private readonly lanIp: string,
        private readonly wanIp: string | null,
        private readonly onMetrics: (serverId: string, snapshot: MetricsSnapshot) => void,
    ) { }

    generateInstallCommand(platform: "linux" | "mac" | "windows", domain: string | null): { command: string; expiresAt: number } {
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + 30 * 60 * 1000;
        this.tokens.set(token, { expiresAt, downloaded: false });

        const externalHost = domain ?? this.wanIp;

        const baseUrl = `https://${this.lanIp}:${NODE_SERVER_PORT}`;
        const controlWs = `wss://${this.lanIp}:${NODE_SERVER_PORT}/node`;
        const altControlWs = externalHost ? `wss://${externalHost}:${NODE_SERVER_PORT}/node` : null;
        const altFlag = altControlWs ? ` --alt-control "${altControlWs}"` : "";

        let command: string;
        if (platform === "windows") {
            command =
                `curl.exe --pinnedpubkey "${this.tls.pin}" -fsSL "${baseUrl}/node-bootstrap/${token}/windows" -o "$env:TEMP\\sc-agent.exe"` +
                `; & "$env:TEMP\\sc-agent.exe" connect --control "${controlWs}"${altFlag} --token "${token}"`;
        } else {
            command =
                `curl --pinnedpubkey "${this.tls.pin}" -fsSL "${baseUrl}/node-bootstrap/${token}/${platform}" -o /tmp/sc-agent` +
                ` && chmod +x /tmp/sc-agent` +
                ` && /tmp/sc-agent connect --control "${controlWs}"${altFlag} --token "${token}"`;
        }

        return { command, expiresAt };
    }

    private validateToken(token: string): boolean {
        const entry = this.tokens.get(token);
        if (!entry) return false;
        if (Date.now() > entry.expiresAt) {
            this.tokens.delete(token);
            return false;
        }
        return true;
    }

    start(): void {
        const self = this;

        Bun.serve<NodeWsData>({
            port: NODE_SERVER_PORT,
            tls: {
                cert: this.tls.certPem,
                key: this.tls.keyPem,
            },
            async fetch(req, serverCtx) {
                const url = new URL(req.url);

                const bootstrapMatch = url.pathname.match(/^\/node-bootstrap\/([^/]+)\/([^/]+)$/);
                if (req.method === "GET" && bootstrapMatch) {
                    const [, token, platform] = bootstrapMatch;
                    if (!self.validateToken(token)) {
                        return new Response("Invalid or expired token", { status: 403 });
                    }
                    const entry = self.tokens.get(token)!;
                    entry.downloaded = true;

                    const binary = PLATFORM_BINARY[platform];
                    if (!binary) return new Response("Unknown platform", { status: 400 });

                    const binPath = path.join(DIST_DIR, binary);
                    try {
                        const file = Bun.file(binPath);
                        return new Response(file, {
                            headers: { "Content-Type": "application/octet-stream" },
                        });
                    } catch {
                        return new Response(`Binary not found: build with 'bun run build:node'`, { status: 404 });
                    }
                }

                if (url.pathname === "/node") {
                    if (serverCtx.upgrade(req, { data: { channel: "node", nodeId: null } satisfies NodeWsData })) {
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

                    const nodeId = ws.data.nodeId;

                    if (!nodeId) {
                        if (msg.type !== "identify") {
                            ws.close(1002, "expected identify");
                            return;
                        }
                        if (!self.validateToken(msg.token)) {
                            ws.close(1008, "invalid token");
                            return;
                        }
                        const id = crypto.randomUUID();
                        ws.data.nodeId = id;

                        const proxy = new NodeProxy(
                            (ctrlMsg) => ws.send(JSON.stringify(ctrlMsg)),
                            id,
                            msg.info.hostname,
                            msg.info,
                            self.onMetrics,
                        );
                        self.agents.set(id, proxy);
                        self.fleet.register(proxy);

                        ws.send(JSON.stringify({ type: "acknowledged", nodeId: id }));
                        console.log(`Node connected: ${msg.info.hostname} (${id})`);
                        return;
                    }

                    self.agents.get(nodeId)?.receive(msg);
                },
                close(ws) {
                    const nodeId = ws.data.nodeId;
                    if (!nodeId) return;
                    const proxy = self.agents.get(nodeId);
                    if (proxy) {
                        proxy.disconnect();
                        self.agents.delete(nodeId);
                        self.fleet.deregister(nodeId);
                        console.log(`Node disconnected: ${proxy.name} (${nodeId})`);
                    }
                },
            },
        });

        console.log(`Node server (HTTPS/WSS) listening on :${NODE_SERVER_PORT}`);

        setInterval(() => {
            const now = Date.now();
            for (const [token, entry] of self.tokens) {
                if (now > entry.expiresAt) self.tokens.delete(token);
            }
        }, 5 * 60 * 1000);
    }
}

function primaryLanIp(): string {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces ?? []) {
            if (!iface.internal && iface.family === "IPv4") return iface.address;
        }
    }
    return "127.0.0.1";
}

export function startNodeServer(
    fleet: Fleet,
    tls: TlsBundle,
    wanIp: string | null,
    onMetrics: (serverId: string, snapshot: MetricsSnapshot) => void,
): NodeServer {
    const server = new NodeServer(fleet, tls, primaryLanIp(), wanIp, onMetrics);
    server.start();
    return server;
}
