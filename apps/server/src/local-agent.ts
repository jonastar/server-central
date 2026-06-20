import * as os from "node:os";
import type { AgentMode, MetricsSnapshot, ServerStatus } from "@central/shared";
import { Agent, AgentTransport, collectSystemInfo, resolveMachineId } from "@central/node";
import type { ExecResult, HostAgent, ShellSession } from "./agent";
import { NodeProxy } from "./node-proxy";

/**
 * The embedded agent — runs in the same process as the control plane.
 * Wires an Agent (runner) to a NodeProxy (server-side interface) via an
 * in-process channel, so the same code path handles both local and remote hosts.
 */
export class LocalAgent implements HostAgent {
    // Resolved from the host's machine id (set in start()), so a separate agent
    // on the same physical machine collapses to one fleet entry rather than a
    // distinct "local" host.
    id = "";
    readonly name = os.hostname();
    // The control plane's own host — permanent, like an installed agent.
    readonly mode: AgentMode = "installed";

    private agent!: Agent;
    private proxy!: NodeProxy;
    private info: ReturnType<NodeProxy["status"]>["info"] = undefined;

    constructor(private readonly onMetrics: (serverId: string, snapshot: MetricsSnapshot) => void) {}

    async start(): Promise<void> {
        this.id = await resolveMachineId();

        // Create proxy first so the agent transport can reference it
        const proxy = new NodeProxy(
            (ctrlMsg) => void this.agent.onMessage(ctrlMsg),
            this.id,
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
        return { serverId: this.id, state: "online", info: this.info, mode: this.mode };
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
