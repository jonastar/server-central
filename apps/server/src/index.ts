import type { ServerWebSocket } from "bun";
import type { ApiEvent, CentralApiOperations, TerminalClientMessage, TerminalServerMessage } from "@central/shared";
import type { ShellSession } from "./agent";
import { Fleet } from "./fleet";
import { CentralHandler } from "./handler";
import { ensureTls } from "./tls";
import { discoverWanIp } from "./stun";
import { startNodeServer } from "./node-server";

type Command = keyof CentralApiOperations;

type WsData =
    | { channel: "events" }
    | { channel: "terminal"; serverId: string; shell: ShellSession | null };

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
};

const eventSockets = new Set<ServerWebSocket<WsData>>();

function broadcast(event: ApiEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of eventSockets) socket.send(payload);
}

const fleet = new Fleet(
    (serverId, snapshot) => broadcast({ kind: "metrics", data: { serverId, snapshot } }),
    (servers) => broadcast({ kind: "serversUpdate", data: servers }),
);
await fleet.init();

const tls = await ensureTls("./.sc-tls");
const wanIp = await discoverWanIp();
if (wanIp) console.log(`Discovered WAN IP: ${wanIp}`);

const nodeServer = startNodeServer(
    fleet,
    tls,
    wanIp,
    (serverId, snapshot) => broadcast({ kind: "metrics", data: { serverId, snapshot } }),
);

const handler = new CentralHandler(fleet, nodeServer);

// ---- Terminal bridge ---------------------------------------------------------

function sendTerminal(ws: ServerWebSocket<WsData>, msg: TerminalServerMessage): void {
    ws.send(JSON.stringify(msg));
}

async function openTerminal(ws: ServerWebSocket<WsData>): Promise<void> {
    if (ws.data.channel !== "terminal") return;
    try {
        const agent = fleet.get(ws.data.serverId);
        const shell = await agent.openShell(80, 24);
        ws.data.shell = shell;
        shell.onData((data) => sendTerminal(ws, { type: "data", data }));
        shell.onExit((code) => {
            sendTerminal(ws, { type: "exit", code });
            ws.close();
        });
    } catch (err) {
        sendTerminal(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
        ws.close();
    }
}

// ---- HTTP / WebSocket ----------------------------------------------------------

const server = Bun.serve<WsData>({
    port: Number(process.env.PORT) || 4141,
    fetch(req, serverCtx) {
        const url = new URL(req.url);

        if (req.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }
        if (url.pathname === "/events") {
            if (serverCtx.upgrade(req, { data: { channel: "events" } satisfies WsData })) {
                return undefined as unknown as Response;
            }
            return new Response("Upgrade failed", { status: 400, headers: corsHeaders });
        }
        if (url.pathname === "/terminal") {
            const serverId = url.searchParams.get("serverId");
            if (!serverId) {
                return Response.json({ error: "serverId required" }, { status: 400, headers: corsHeaders });
            }
            const data: WsData = { channel: "terminal", serverId, shell: null };
            if (serverCtx.upgrade(req, { data })) return undefined as unknown as Response;
            return new Response("Upgrade failed", { status: 400, headers: corsHeaders });
        }
        if (req.method !== "POST") {
            return Response.json({ error: "Use POST" }, { status: 405, headers: corsHeaders });
        }

        const command = url.pathname.replace(/^\//, "") as Command;
        const fn = (handler[command] as ((data: unknown) => Promise<unknown>) | undefined)?.bind(handler);
        if (!fn) {
            return Response.json({ error: `Unknown command: ${command}` }, { status: 404, headers: corsHeaders });
        }

        return req
            .json()
            .catch(() => null)
            .then(async (data) => {
                try {
                    const result = await fn(data ?? undefined);
                    return new Response(result === undefined ? "null" : JSON.stringify(result), {
                        headers: { ...corsHeaders, "Content-Type": "application/json" },
                    });
                } catch (err) {
                    const message = err instanceof Error ? err.message : "Unexpected server error";
                    return Response.json({ error: message }, { status: 500, headers: corsHeaders });
                }
            });
    },
    websocket: {
        open(ws) {
            if (ws.data.channel === "events") {
                eventSockets.add(ws);
                ws.send(JSON.stringify({
                    kind: "init",
                    data: { servers: fleet.entries(), metricsHistory: fleet.metricsHistory() },
                } satisfies ApiEvent));
            } else {
                void openTerminal(ws);
            }
        },
        message(ws, message) {
            if (ws.data.channel !== "terminal" || !ws.data.shell) return;
            try {
                const msg = JSON.parse(String(message)) as TerminalClientMessage;
                if (msg.type === "input") ws.data.shell.write(msg.data);
                else if (msg.type === "resize") ws.data.shell.resize(msg.cols, msg.rows);
            } catch { /* ignore malformed frames */ }
        },
        close(ws) {
            if (ws.data.channel === "events") eventSockets.delete(ws);
            else ws.data.shell?.close();
        },
    },
});

console.log(`Server Central backend running at http://localhost:${server.port}`);
