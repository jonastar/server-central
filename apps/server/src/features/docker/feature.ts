import type {
    HostCapabilityResult,
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
import type { AgentFeature } from "../../feature";
import { defineFeature } from "../../feature";
import type { Fleet } from "../../fleet";
import type { ComposeStackStore } from "../compose/store";
import { requireAgent, type TaskCtx } from "../../tasks/types";
import * as os from "node:os";
import { accessible, constants, exists, which } from "../../agent/probe-utils";

export const createDockerFeature = (fleet: Fleet, stacks: ComposeStackStore) => defineFeature({
    id: "docker",
    name: "Docker",
    description: "Container/volume/image/stack management on a host.",
    experimental: false,
    requiresHostCapability: "docker",
    ops: {
        async list(data) {
            return dockerList(fleet.get(data.serverId));
        },

        async containerLogs(data) {
            const { serverId, containerId, ...opts } = data;
            return { logs: await dockerContainerLogs(fleet.get(serverId), containerId, opts) };
        },

        async overview(data) {
            return dockerOverview(fleet.get(data.serverId));
        },


        async containerInspect(data) {
            return dockerContainerInspect(fleet.get(data.serverId), data.containerId);
        },

        async containerExec(data) {
            return dockerContainerExec(fleet.get(data.serverId), data.containerId, data.command);
        },

        async volumeInspect(data) {
            return dockerVolumeInspect(fleet.get(data.serverId), data.name);
        },

        async volumeRemove(data) {
            await dockerVolumeRemove(fleet.get(data.serverId), data.name);
        },

        async imageAction(data) {
            await dockerImageAction(fleet.get(data.serverId), data.imageId, data.action);
        },

        async imageDefaults(data) {
            return imageDefaults(fleet.get(data.serverId), data.image);
        },
    },
    tasks: {
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
            const stack = stacks.get(spec.stackId);
            await composeStackAction(
                requireAgent(ctx, "docker_compose_action"),
                stack.dir,
                stack.composeFile,
                stack.project,
                spec.action,
                spec.pullFirst,
                ctx.log,
                spec.service,
            );
            return { kind: "docker_compose_action" };
        },
    },
});



/** `stacks` is here rather than on `TaskCtx` because `docker_compose_action` is
 *  the only kind that needs it — a feature closing over its own collaborators,
 *  the same way every other feature takes `fleet`. */
/**
 * The daemon socket, not the client binary: a `docker` CLI on a host whose
 * daemon isn't running (or whose socket the agent can't open) is the same false
 * positive as ZFS-without-the-module. A remote daemon via DOCKER_HOST can't be
 * confirmed without a network call, so that case reports available with a note
 * rather than pretending to have probed it.
 */
export function dockerAgentFeature(): AgentFeature {
    return {
        id: "docker",
        hostProbe: {
            capability: "docker",
            async probe(): Promise<HostCapabilityResult> {
                const cli = await which("docker");
                const socket = "/var/run/docker.sock";

                if (process.env.DOCKER_HOST) {
                    return cli
                        ? { available: true, detail: `Using the remote daemon at DOCKER_HOST (${process.env.DOCKER_HOST}); reachability isn't probed.` }
                        : { available: false, detail: "DOCKER_HOST is set but the docker CLI isn't installed on this host." };
                }
                if (!cli && !await exists(socket)) {
                    return { available: false, detail: "Docker isn't installed on this host." };
                }
                if (!cli) {
                    return { available: false, detail: "A Docker daemon socket is present but the docker CLI isn't on the agent's PATH." };
                }
                if (!await exists(socket)) {
                    return { available: false, detail: "Docker is installed but its daemon socket isn't present — the daemon may not be running." };
                }
                if (!await accessible(socket, constants.R_OK | constants.W_OK)) {
                    return { available: false, detail: `The Docker socket exists but the agent (uid ${os.userInfo().uid}) can't open it — add its user to the docker group.` };
                }
                return { available: true };
            },
        },
    };
}
