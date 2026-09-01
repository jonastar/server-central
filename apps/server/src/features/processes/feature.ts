import type { ProcessInfo } from "@central/shared";
import type { Feature, FeatureApiHandlers } from "../../feature";
import type { Fleet } from "../../fleet";

export function createProcessesFeature(fleet: Fleet): Feature<ProcessesOps> {
    return {
        descriptor: {
            id: "processes",
            name: "Processes",
            description: "Running-process listing on a host.",
            experimental: false,
        },
        apiHandlers() {
            return processesApiHandlers(fleet);
        },
    };
}

export type ProcessesOps = "getProcesses";

export function processesApiHandlers(fleet: Fleet): FeatureApiHandlers<ProcessesOps> {
    return {
        async handleGetProcesses(data: { serverId: string }): Promise<ProcessInfo[]> {
            const res = await fleet.get(data.serverId).run(["ps", "aux"]);
            const out: ProcessInfo[] = [];
            for (const line of res.stdout.split("\n").slice(1)) {
                const f = line.trim().split(/\s+/);
                if (f.length < 11) {
                    continue;
                }
                out.push({
                    user: f[0],
                    pid: Number(f[1]),
                    cpuPct: Number(f[2]) || 0,
                    memPct: Number(f[3]) || 0,
                    rssKb: Number(f[5]) || 0,
                    started: f[8],
                    command: f.slice(10).join(" "),
                });
            }
            return out.sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 300);
        },
    };
}
