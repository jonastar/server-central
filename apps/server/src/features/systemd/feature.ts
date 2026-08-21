import type {
    CentralApiOperations,
    HostCapabilityResult,
    SystemdState,
    TaskServiceAction,
    TaskServiceActionResult,
} from "@central/shared";
import type { AgentFeature, Feature, FeatureApiHandlers, FeatureTaskHandlers } from "../../feature";
import type { Fleet } from "../../fleet";
import { systemdList, systemdServiceAction, systemdServiceLogs, systemdUnitFile } from "./systemd";
import { requireAgent, type TaskCtx } from "../../tasks/types";
import { accessible, constants, exists, which } from "../../agent/probe-utils";

export function createSystemdFeature(fleet: Fleet): Feature<SystemdOps, "service_action"> {
    return {
        descriptor: {
            id: "systemd",
            name: "Systemd",
            description: "systemd service inspection and control on a host.",
            experimental: false,
            requiresHostCapability: "systemd",
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

/**
 * `/run/systemd/system` is the check systemd's own sd_booted(3) documents: it
 * exists only when systemd is running as PID 1. Probing the `systemctl` binary
 * instead reports true on any host that merely has the package — including
 * containers running s6, openrc, or a bare process — where every service
 * operation then fails with "system has not been booted with systemd".
 */
export function systemdAgentFeature(): AgentFeature {
    return {
        id: "systemd",
        hostProbe: {
            capability: "systemd",
            async probe(): Promise<HostCapabilityResult> {
                if (!await exists("/run/systemd/system")) {
                    return { available: false, detail: "This host isn't running systemd as its init system." };
                }
                if (!await which("systemctl")) {
                    return { available: false, detail: "systemd is running but `systemctl` isn't on the agent's PATH." };
                }
                return { available: true };
            },
        },
    };
}
