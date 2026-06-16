import type { NodeMessage, SystemInfo } from "@central/shared";
import { Agent, AgentTransport, collectSystemInfo } from "./agent";

// ---- CLI argument parsing ----------------------------------------------------

function parseArgs(): { control: string; altControl: string | null; token: string } {
    const args = process.argv.slice(2);
    if (args[0] !== "connect") {
        console.error("Usage: sc-agent connect --control <url> [--alt-control <url>] --token <token>");
        process.exit(1);
    }

    let control: string | null = null;
    let altControl: string | null = null;
    let token: string | null = null;

    for (let i = 1; i < args.length; i++) {
        if (args[i] === "--control") control = args[++i];
        else if (args[i] === "--alt-control") altControl = args[++i];
        else if (args[i] === "--token") token = args[++i];
    }

    if (!control || !token) {
        console.error("--control and --token are required");
        process.exit(1);
    }

    return { control, altControl, token };
}

// ---- WebSocket transport -----------------------------------------------------

class WsTransport implements AgentTransport {
    constructor(private readonly ws: WebSocket) {}

    send(msg: NodeMessage): void {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }
}

// ---- Connection --------------------------------------------------------------

const RECONNECT_DELAY_MS = 5_000;

async function connect(url: string, token: string, info: SystemInfo): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, {
            // @ts-expect-error Bun-specific TLS option; pubkey pinning done via the install command
            tls: { rejectUnauthorized: false },
        });

        ws.onopen = () => {
            ws.send(JSON.stringify({ type: "identify", token, info } satisfies NodeMessage));
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(String(event.data));
                if (msg.type === "acknowledged") {
                    console.log(`Connected to control plane (node ID: ${msg.nodeId})`);
                    resolve(ws);
                }
            } catch { }
        };

        ws.onerror = (err) => reject(err);
        ws.onclose = () => reject(new Error("Connection closed before acknowledged"));
    });
}

async function runWithUrl(url: string, token: string, info: SystemInfo): Promise<void> {
    const ws = await connect(url, token, info);
    const agent = new Agent(new WsTransport(ws), false);
    agent.startMetrics();

    return new Promise((resolve) => {
        ws.onmessage = (event) => {
            try {
                void agent.onMessage(JSON.parse(String(event.data)));
            } catch { }
        };

        ws.onclose = () => { agent.stopMetrics(); resolve(); };
        ws.onerror = () => { agent.stopMetrics(); resolve(); };
    });
}

// ---- Main loop ---------------------------------------------------------------

async function main(): Promise<void> {
    const { control, altControl, token } = parseArgs();
    const info = await collectSystemInfo();
    const urls = [control, ...(altControl ? [altControl] : [])];

    console.log(`sc-agent starting, connecting to ${control}`);

    while (true) {
        let connected = false;
        for (const url of urls) {
            try {
                await runWithUrl(url, token, info);
                connected = true;
                break;
            } catch (err) {
                console.warn(`Failed to connect to ${url}:`, (err as Error).message);
            }
        }

        if (!connected) {
            console.log(`All control plane URLs failed, retrying in ${RECONNECT_DELAY_MS / 1000}s…`);
        } else {
            console.log(`Disconnected, reconnecting in ${RECONNECT_DELAY_MS / 1000}s…`);
        }

        await Bun.sleep(RECONNECT_DELAY_MS);
        Object.assign(info, await collectSystemInfo());
    }
}

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
