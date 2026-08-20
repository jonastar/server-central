import type {
    CentralApiOperations,
    DockerContainerDetail,
    DockerExecResult,
    DockerOverview,
    DockerStacksState,
    DockerState,
    DockerVolumeDetail,
    ImageAction,
    ImageDefaults,
    TaskDockerComposeAction,
    TaskDockerComposeActionResult,
    TaskDockerContainerAction,
    TaskDockerContainerActionResult,
    TaskDockerImagePull,
    TaskDockerImagePullResult,
    TaskDockerStackAction,
    TaskDockerStackActionResult,
} from "@central/shared";
import {
    composeStackAction,
    dockerContainerAction,
    dockerContainerExec,
    dockerContainerInspect,
    dockerImageAction,
    dockerImagePull,
    dockerList,
    dockerOverview,
    dockerStackAction,
    dockerStacks,
    dockerVolumeInspect,
    dockerVolumeRemove,
    imageDefaults,
    dockerContainerLogs,
} from "./docker";
import type { Feature, FeatureApiHandlers, FeatureTaskHandlers } from "../../feature";
import type { Fleet } from "../../fleet";
import { requireAgent, type TaskCtx } from "../../tasks/types";

export function createDockerFeature(fleet: Fleet): Feature<DockerOps, DockerTaskKind> {
    return {
        descriptor: {
            id: "docker",
            name: "Docker",
            description: "Container/volume/image/stack management on a host.",
            experimental: false,
        },
        apiHandlers() {
            return dockerApiHandlers(fleet);
        },
        taskHandlers() {
            return dockerTaskHandlers();
        },
    };
}

export type DockerOps = "dockerList" | "dockerContainerLogs" | "dockerOverview" | "dockerStacks"
    | "dockerContainerInspect" | "dockerContainerExec" | "dockerVolumeInspect" | "dockerVolumeRemove"
    | "dockerImageAction" | "dockerImageDefaults";

export function dockerApiHandlers(fleet: Fleet): FeatureApiHandlers<DockerOps> {
    return {
        async handleDockerList(data: { serverId: string }): Promise<DockerState> {
            return dockerList(fleet.get(data.serverId));
        },

        async handleDockerContainerLogs(data: CentralApiOperations["dockerContainerLogs"]["data"]): Promise<{ logs: string }> {
            const { serverId, containerId, ...opts } = data;
            return { logs: await dockerContainerLogs(fleet.get(serverId), containerId, opts) };
        },

        async handleDockerOverview(data: { serverId: string }): Promise<DockerOverview> {
            return dockerOverview(fleet.get(data.serverId));
        },

        async handleDockerStacks(data: { serverId: string }): Promise<DockerStacksState> {
            return dockerStacks(fleet.get(data.serverId));
        },

        async handleDockerContainerInspect(data: { serverId: string; containerId: string }): Promise<DockerContainerDetail> {
            return dockerContainerInspect(fleet.get(data.serverId), data.containerId);
        },

        async handleDockerContainerExec(data: { serverId: string; containerId: string; command: string }): Promise<DockerExecResult> {
            return dockerContainerExec(fleet.get(data.serverId), data.containerId, data.command);
        },

        async handleDockerVolumeInspect(data: { serverId: string; name: string }): Promise<DockerVolumeDetail> {
            return dockerVolumeInspect(fleet.get(data.serverId), data.name);
        },

        async handleDockerVolumeRemove(data: { serverId: string; name: string }): Promise<void> {
            await dockerVolumeRemove(fleet.get(data.serverId), data.name);
        },

        async handleDockerImageAction(data: { serverId: string; imageId: string; action: ImageAction }): Promise<void> {
            await dockerImageAction(fleet.get(data.serverId), data.imageId, data.action);
        },

        async handleDockerImageDefaults(data: { serverId: string; image: string }): Promise<ImageDefaults> {
            return imageDefaults(fleet.get(data.serverId), data.image);
        },
    };
}

type DockerTaskKind = "docker_stack_action" | "docker_container_action" | "docker_image_pull" | "docker_compose_action";

export function dockerTaskHandlers(): FeatureTaskHandlers<DockerTaskKind> {
    return {
        async docker_stack_action(spec: TaskDockerStackAction, ctx: TaskCtx): Promise<TaskDockerStackActionResult> {
            await dockerStackAction(requireAgent(ctx, "docker_stack_action"), spec.project, spec.action, ctx.log);
            return { kind: "docker_stack_action" };
        },

        async docker_container_action(spec: TaskDockerContainerAction, ctx: TaskCtx): Promise<TaskDockerContainerActionResult> {
            await dockerContainerAction(requireAgent(ctx, "docker_container_action"), spec.containerId, spec.action, ctx.log);
            return { kind: "docker_container_action" };
        },

        async docker_image_pull(spec: TaskDockerImagePull, ctx: TaskCtx): Promise<TaskDockerImagePullResult> {
            const { ok, message } = await dockerImagePull(requireAgent(ctx, "docker_image_pull"), spec.ref, ctx.log);
            return { kind: "docker_image_pull", ok, message };
        },

        async docker_compose_action(spec: TaskDockerComposeAction, ctx: TaskCtx): Promise<TaskDockerComposeActionResult> {
            const app = ctx.apps.get(spec.appId);
            await composeStackAction(
                requireAgent(ctx, "docker_compose_action"),
                app.dir,
                app.composeFile,
                app.project,
                spec.action,
                spec.pullFirst,
                ctx.log,
                spec.service,
            );
            return { kind: "docker_compose_action" };
        },
    };
}
