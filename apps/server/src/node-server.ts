import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "bun";
import type { MetricsSnapshot, NodeMessage } from "@central/shared";
import { ensureTls, localIps, type TlsBundle } from "./tls";
import { HostAgent } from "./host-agent";
import type { Fleet } from "./fleet";
import { readAgentTokens, readConfig, writeAgentTokens } from "./config";
import { BinaryStoreError, resolveAgentBinary } from "./binary-store";

export const NODE_SERVER_PORT = 4142;

type NodeWsData = { channel: "node"; connId: string | null; remoteIp: string | null };

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
        private tls: TlsBundle,
        private readonly lanIp: string,
        private readonly wanIp: string | null,
        private readonly onMetrics: (serverId: string, snapshot: MetricsSnapshot) => void,
        private readonly tlsDir: string | null = null,
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

    /** The control plane's external address (configured domain, else discovered
     *  WAN IP) — used for off-LAN reconnects and, when requested, as the install
     *  command's primary host. Null when neither is known. */
    externalHost(domain: string | null): string | null {
        return domain ?? this.wanIp;
    }

    /** Control-plane URLs an agent connects/downloads with. By default the LAN
     *  address is primary with the external (domain/WAN) host as an off-LAN alt;
     *  when useExternal is set the two swap, so a machine off the LAN reaches the
     *  control plane directly. */
    private endpoints(domain: string | null, useExternal = false): { baseUrl: string; controlWs: string; altControlWs: string | null } {
        const externalHost = this.externalHost(domain);
        const primaryHost = useExternal && externalHost ? externalHost : this.lanIp;
        const altHost = useExternal && externalHost ? this.lanIp : externalHost;
        return {
            baseUrl: `https://${primaryHost}:${NODE_SERVER_PORT}`,
            controlWs: `wss://${primaryHost}:${NODE_SERVER_PORT}/node`,
            altControlWs: altHost && altHost !== primaryHost ? `wss://${altHost}:${NODE_SERVER_PORT}/node` : null,
        };
    }

    generateInstallCommand(platform: "linux" | "mac" | "windows", domain: string | null, useExternal = false): { command: string; expiresAt: number; externalHost: string | null } {
        const { token, expiresAt } = this.mintToken();
        const { baseUrl, controlWs, altControlWs } = this.endpoints(domain, useExternal);
        const pinned = `-k --pinnedpubkey "${this.tls.pin}"`;

        let command: string;
        if (platform === "windows") {
            const altFlag = altControlWs ? ` --alt-control "${altControlWs}"` : "";
            command =
                `curl.exe ${pinned} -fsSL "${baseUrl}/node-bootstrap/${token}/windows-x64" -o "$env:TEMP\\sc-agent.exe"` +
                `; curl.exe ${pinned} -fsSL "${baseUrl}/node-cert" -o "$env:TEMP\\sc-agent.crt"` +
                `; & "$env:TEMP\\sc-agent.exe" --agent --control "${controlWs}"${altFlag} --token "${token}" --cert "$env:TEMP\\sc-agent.crt"`;
        } else {
            // Unix: pipe a (pinned) bootstrap script into a root shell. The script
            // downloads the binary + embedded cert into the current dir, runs the
            // live agent in the foreground, and cleans up on exit. Run as root: the
            // agent manages the host and, when promoted from the web UI, installs
            // itself as a service. See bootstrap.sh. The external flag is carried
            // in the URL so the separately-fetched bootstrap renders the same
            // (external-primary) endpoints the download URL used.
            const query = useExternal ? "?external=1" : "";
            command = `curl ${pinned} -fsSL "${baseUrl}/node-install/${token}${query}" | sudo bash`;
        }

        return { command, expiresAt, externalHost: this.externalHost(domain) };
    }

    /** Render the unix bootstrap script for `token` (token/cert/pin/URLs filled in). */
    async renderBootstrap(token: string, domain: string | null, useExternal = false): Promise<string> {
        const { baseUrl, controlWs, altControlWs } = this.endpoints(domain, useExternal);
        const altFlag = altControlWs ? `--alt-control ${altControlWs}` : "";
        const tpl = await NodeServer.bootstrapScript();
        // Function replacements so `$`/`$&` in the substituted values aren't treated
        // as replacement patterns.
        return tpl
            .replaceAll("__TOKEN__", () => token)
            .replaceAll("__PIN__", () => this.tls.pin)
            .replaceAll("__BASE_URL__", () => baseUrl)
            .replaceAll("__CONTROL_WS__", () => controlWs)
            .replaceAll("__ALT_FLAG__", () => altFlag)
            .replaceAll("__CERT__", () => this.tls.caCertPem.trim());
    }

    /** Read + cache the bootstrap.sh template (from source, like DIST_DIR). */
    private static scriptPromise: Promise<string> | null = null;
    private static bootstrapScript(): Promise<string> {
        return (NodeServer.scriptPromise ??= Bun.file(path.resolve(import.meta.dir, "agent/bootstrap.sh")).text());
    }

    /** Serve the agent binary for `platform`, resolved by the binary store (local
     *  cache → dist/ → release source). Maps store errors to HTTP statuses. */
    private static async binaryResponse(platform: string): Promise<Response> {
        try {
            const binPath = await resolveAgentBinary(platform);
            return new Response(Bun.file(binPath), {
                headers: { "Content-Type": "application/octet-stream" },
            });
        } catch (err) {
            if (err instanceof BinaryStoreError) {
                return new Response(err.message, { status: err.status });
            }
            console.error(`[binary-store] failed to resolve ${platform}: ${(err as Error)?.message ?? err}`);
            return new Response("Failed to resolve agent binary", { status: 502 });
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
        this.listen();
        this.tokenSweep = setInterval(() => {
            const now = Date.now();
            for (const [token, entry] of this.tokens) {
                if (now > entry.expiresAt) {
                    this.tokens.delete(token);
                }
            }
        }, 5 * 60 * 1000);
        // Don't keep the process alive on this timer alone (matters for tests).
        this.tokenSweep.unref?.();
    }

    /**
     * Re-issue the leaf for the current domain/WAN/LAN and, if it changed, rebind the
     * listener so the new cert is served. Needs tlsDir (set in production). Agents
     * trust the CA, so a leaf swap is transparent — they just reconnect. Returns
     * whether the cert changed. Bun's server.reload() does NOT hot-swap TLS, so we
     * stop and re-listen on the same port.
     */
    async refreshTls(): Promise<boolean> {
        if (!this.tlsDir) {
            return false;
        }
        const cfg = await readConfig();
        const bundle = await ensureTls(this.tlsDir, {
            domain: cfg.domain ?? null,
            wanIp: this.wanIp,
            lanIps: localIps(),
        });
        if (bundle.certPem === this.tls.certPem) {
            return false;
        }
        this.tls = bundle;
        this.server?.stop(true);
        this.listen();
        console.log("Node server TLS leaf re-issued and listener rebound");
        return true;
    }

    private listen(): void {
        const self = this;

        this.server = Bun.serve<NodeWsData>({
            port: this.listenPort,
            tls: {
                cert: this.tls.certPem,
                key: this.tls.keyPem,
            },
            async fetch(req, serverCtx) {
                const url = new URL(req.url);

                // The CA cert is the agents' trust anchor (not the served leaf).
                if (req.method === "GET" && url.pathname === "/node-cert") {
                    return new Response(self.tls.caCertPem, {
                        headers: { "Content-Type": "application/x-pem-file" },
                    });
                }

                // Unix install: the (pinned) bootstrap script, run via `… | sudo bash`.
                const installMatch = url.pathname.match(/^\/node-install\/([^/]+)$/);
                if (req.method === "GET" && installMatch) {
                    const [, token] = installMatch;
                    if (!self.validateToken(token)) {
                        return new Response("Invalid or expired token", { status: 403 });
                    }
                    const cfg = await readConfig();
                    const useExternal = url.searchParams.get("external") === "1";
                    return new Response(await self.renderBootstrap(token, cfg.domain ?? null, useExternal), {
                        headers: { "Content-Type": "text/x-shellscript" },
                    });
                }

                const bootstrapMatch = url.pathname.match(/^\/node-bootstrap\/([^/]+)\/([^/]+)$/);
                if (req.method === "GET" && bootstrapMatch) {
                    const [, token, platform] = bootstrapMatch;
                    if (!self.validateToken(token)) {
                        return new Response("Invalid or expired token", { status: 403 });
                    }
                    self.tokens.get(token)!.downloaded = true;
                    return await NodeServer.binaryResponse(platform);
                }

                // Binary fetch for an installed agent's self-update — same binaries
                // as bootstrap, but authenticated by the agent's durable token (so
                // it doesn't touch the short-lived enrollment token map).
                const binaryMatch = url.pathname.match(/^\/node-binary\/([^/]+)\/([^/]+)$/);
                if (req.method === "GET" && binaryMatch) {
                    const [, token, platform] = binaryMatch;
                    if (!self.validateToken(token)) {
                        console.warn(`[update] node-binary fetch rejected (platform ${platform}): invalid or expired token`);
                        return new Response("Invalid or expired token", { status: 403 });
                    }
                    console.log(`[update] serving self-update binary (platform ${platform})`);
                    return await NodeServer.binaryResponse(platform);
                }

                if (url.pathname === "/node") {
                    const remoteIp = serverCtx.requestIP(req)?.address ?? null;
                    if (serverCtx.upgrade(req, { data: { channel: "node", connId: null, remoteIp } satisfies NodeWsData })) {
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
                            ws.data.remoteIp,
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
    tlsDir: string | null = null,
): Promise<NodeServer> {
    const server = new NodeServer(fleet, tls, primaryLanIp(), wanIp, onMetrics, tlsDir);
    await server.init();
    server.start();
    return server;
}
