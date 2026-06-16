import * as os from "node:os";
import type { MetricsSnapshot, ServerStatus } from "@central/shared";
import { Agent, AgentTransport, collectSystemInfo } from "@central/node";
import type { ExecResult, HostAgent, ShellSession } from "./agent";
import { NodeProxy } from "./node-proxy";

const EMBEDDED_ID = "local";

/**
 * The embedded agent — runs in the same process as the control plane.
 * Wires an Agent (runner) to a NodeProxy (server-side interface) via an
 * in-process channel, so the same code path handles both local and remote hosts.
 */
export class LocalAgent implements HostAgent {
    readonly id = EMBEDDED_ID;
    readonly name = os.hostname();

    private agent!: Agent;
    private proxy!: NodeProxy;
    private info: ReturnType<NodeProxy["status"]>["info"] = undefined;

    constructor(private readonly onMetrics: (serverId: string, snapshot: MetricsSnapshot) => void) {}

    async start(): Promise<void> {
        // Create proxy first so the agent transport can reference it
        const proxy = new NodeProxy(
            (ctrlMsg) => void this.agent.onMessage(ctrlMsg),
            EMBEDDED_ID,
            os.hostname(),
            null,
            this.onMetrics,
        );
        this.proxy = proxy;

        const agentTransport: AgentTransport = { send: (nodeMsg) => proxy.receive(nodeMsg) };
        this.agent = new Agent(agentTransport, true);

        const sysInfo = await collectSystemInfo();
        proxy.setInfo(sysInfo);
        this.info = sysInfo;

        this.agent.startMetrics();
    }

    stop(): void {
        this.agent?.stopMetrics();
    }

    status(): ServerStatus {
        return { serverId: this.id, state: "online", info: this.info };
    }

    get history(): MetricsSnapshot[] { return this.proxy?.history ?? []; }

    exec(command: string): Promise<ExecResult> { return this.proxy.exec(command); }
    listDir(p: string) { return this.proxy.listDir(p); }
    readFile(p: string) { return this.proxy.readFile(p); }
    writeFile(p: string, content: string) { return this.proxy.writeFile(p, content); }
    createDir(p: string) { return this.proxy.createDir(p); }
    deletePath(p: string) { return this.proxy.deletePath(p); }
    renamePath(from: string, to: string) { return this.proxy.renamePath(from, to); }
    openShell(cols: number, rows: number): Promise<ShellSession> { return this.proxy.openShell(cols, rows); }
}
