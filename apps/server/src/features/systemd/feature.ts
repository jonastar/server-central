import type { CentralApiOperations, SystemdState, TaskServiceAction, TaskServiceActionResult } from "@central/shared";
import type { Feature, FeatureApiHandlers, FeatureTaskHandlers } from "../../feature";
import type { Fleet } from "../../fleet";
import { systemdList, systemdServiceAction, systemdServiceLogs, systemdUnitFile } from "./systemd";
import { requireAgent, type TaskCtx } from "../../tasks/types";

export function createSystemdFeature(fleet: Fleet): Feature<SystemdOps, "service_action"> {
    return {
        descriptor: {
            id: "systemd",
            name: "Systemd",
            description: "systemd service inspection and control on a host.",
            experimental: false,
        },
        apiHandlers() {
            return systemdApiHandlers(fleet);
        },
        taskHandlers() {
            return systemdTaskHandlers();
        },
    };
}

export type SystemdOps = "systemdList" | "systemdServiceLogs" | "systemdUnitFile";

export function systemdApiHandlers(fleet: Fleet): FeatureApiHandlers<SystemdOps> {
    return {
        async handleSystemdList(data: { serverId: string }): Promise<SystemdState> {
            return systemdList(fleet.get(data.serverId));
        },

        async handleSystemdServiceLogs(data: CentralApiOperations["systemdServiceLogs"]["data"]): Promise<{ logs: string }> {
            const { serverId, unit, ...opts } = data;
            return { logs: await systemdServiceLogs(fleet.get(serverId), unit, opts) };
        },

        async handleSystemdUnitFile(data: { serverId: string; unit: string }): Promise<{ content: string }> {
            return { content: await systemdUnitFile(fleet.get(data.serverId), data.unit) };
        },
    };
}

export function systemdTaskHandlers(): FeatureTaskHandlers<"service_action"> {
    return {
        async service_action(spec: TaskServiceAction, ctx: TaskCtx): Promise<TaskServiceActionResult> {
            await systemdServiceAction(requireAgent(ctx, "service_action"), spec.unit, spec.action, ctx.log);
            return { kind: "service_action" };
        },
    };
}
