import * as fs from "node:fs/promises";
import type { AgentMode, NodeMessage, SystemInfo } from "@central/shared";
import { CONTROL_PLANE_TLS_SERVERNAME } from "@central/shared";
import { Agent, type AgentTransport, collectSystemInfo, resolveMachineId } from "./agent";

// ---- CLI argument parsing ----------------------------------------------------

const USAGE = "Usage: sc-server --agent --control <url> [--alt-control <url>] --token <token> --cert <path> [--mode live|installed]";

interface Args {
    control: string;
    altControl: string | null;
    token: string;
    cert: string;
    mode: AgentMode;
}

function parseArgs(args: string[]): Args {
    let control: string | null = null;
    let altControl: string | null = null;
    let token: string | null = null;
    let cert: string | null = null;
    let mode: AgentMode = "live";

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--agent") continue;
        else if (args[i] === "--control") control = args[++i];
        else if (args[i] === "--alt-control") altControl = args[++i];
        else if (args[i] === "--token") token = args[++i];
        else if (args[i] === "--cert") cert = args[++i];
        else if (args[i] === "--mode") {
            const value = args[++i];
            if (value !== "live" && value !== "installed") {
                console.error(`--mode must be "live" or "installed"`);
                process.exit(1);
            }
            mode = value;
        }
    }

    if (!control || !token || !cert) {
        console.error("--control, --token, and --cert are required");
        console.error(USAGE);
        process.exit(1);
    }

    return { control, altControl, token, cert, mode };
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

interface Identity {
    token: string;
    machineId: string;
    mode: AgentMode;
    info: SystemInfo;
    certPem: string;
}

// ---- Self-install (live → systemd service) -----------------------------------

const INSTALL_BIN = "/usr/local/bin/sc-agent";
const INSTALL_CERT = "/etc/sc-agent/agent.crt";
const UNIT_PATH = "/etc/systemd/system/sc-agent.service";

async function run(cmd: string, args: string[]): Promise<void> {
    const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
        const err = (await new Response(proc.stderr).text()).trim();
        throw new Error(`${cmd} ${args.join(" ")} failed (exit ${code})${err ? `: ${err}` : ""}`);
    }
}

/**
 * Promote this live agent to a permanent systemd service: drop the binary and
 * cert at stable paths, write+enable a unit that reconnects with the durable
 * token in `--mode installed`, then exit so the service takes over. Errors out
 * if a unit already exists (per the add-server flow design).
 */
async function installSelf(opts: { control: string; altControl: string | null; certPem: string; agentToken: string }): Promise<void> {
    if (process.platform !== "linux") throw new Error("Service install is only supported on Linux");
    if (await Bun.file(UNIT_PATH).exists()) throw new Error("sc-agent service is already installed");

    await fs.mkdir("/etc/sc-agent", { recursive: true });
    await fs.copyFile(process.execPath, INSTALL_BIN);
    await fs.chmod(INSTALL_BIN, 0o755);
    await fs.writeFile(INSTALL_CERT, opts.certPem, { mode: 0o600 });

    const alt = opts.altControl ? ` --alt-control "${opts.altControl}"` : "";
    const execStart = `${INSTALL_BIN} --agent --control "${opts.control}"${alt} --token "${opts.agentToken}" --cert "${INSTALL_CERT}" --mode installed`;
    const unit = `[Unit]
Description=Server Central Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
    await fs.writeFile(UNIT_PATH, unit);

    await run("systemctl", ["daemon-reload"]);
    await run("systemctl", ["enable", "--now", "sc-agent"]);

    console.log("Installed as systemd service; the installed agent will take over. Exiting live agent.");
    // The installed service connects (mode installed) and takes priority; step
    // aside shortly so the handoff completes. Delay so the success reply is sent.
    setTimeout(() => process.exit(0), 1500);
}

async function connect(url: string, id: Identity): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, {
            // @ts-expect-error Bun-specific TLS option
            // ca pins the exact control-plane cert (the trust anchor). Bun enforces
            // hostname↔SAN verification at the TLS layer and ignores
            // checkServerIdentity, so we send a fixed servername that matches the
            // cert SAN — making validation succeed whether we connect by IP or domain.
            tls: { ca: id.certPem, servername: CONTROL_PLANE_TLS_SERVERNAME },
        });

        ws.onopen = () => {
            ws.send(JSON.stringify({
                type: "identify", token: id.token, info: id.info, machineId: id.machineId, mode: id.mode,
            } satisfies NodeMessage));
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(String(event.data));
                if (msg.type === "acknowledged") {
                    const standby = msg.active ? "" : " (standby — another agent is active for this machine)";
                    console.log(`Connected to control plane (machine ${msg.nodeId}, mode ${id.mode})${standby}`);
                    resolve(ws);
                }
            } catch { }
        };

        ws.onerror = (err) => reject(err);
        ws.onclose = () => reject(new Error("Connection closed before acknowledged"));
    });
}

async function runWithUrl(url: string, id: Identity, onInstallService: (agentToken: string) => Promise<void>): Promise<void> {
    const ws = await connect(url, id);
    const agent = new Agent(new WsTransport(ws), false, onInstallService);
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

// ---- Entry -------------------------------------------------------------------

/** Run as a host agent (`server --agent …`), connecting to a control plane. */
export async function runAgentCli(argv: string[]): Promise<void> {
    const { control, altControl, token, cert, mode } = parseArgs(argv);
    const certPem = await Bun.file(cert).text();
    const info = await collectSystemInfo();
    const machineId = await resolveMachineId();
    const id: Identity = { token, machineId, mode, info, certPem };
    const urls = [control, ...(altControl ? [altControl] : [])];

    // The control URLs the installed service should reconnect with are the same
    // ones this live agent was given.
    const onInstallService = (agentToken: string) => installSelf({ control, altControl, certPem, agentToken });

    console.log(`sc-agent starting (mode ${mode}, machine ${machineId}), connecting to ${control}`);

    while (true) {
        let connected = false;
        for (const url of urls) {
            try {
                await runWithUrl(url, id, onInstallService);
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
