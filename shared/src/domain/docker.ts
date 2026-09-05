import type { LogQuery } from "./logs";

// ---- Docker ------------------------------------------------------------------

export interface ContainerInfo {
    id: string;
    name: string;
    image: string;
    /** running | exited | paused | created | restarting | dead */
    state: string;
    /** Human status, e.g. "Up 3 days" */
    status: string;
    ports: string;
    createdAt: string;
    /** Compose project (com.docker.compose.project label), if any. */
    project?: string;
    /** Compose service (com.docker.compose.service label), if any. */
    service?: string;
}

export interface DockerVolumeInfo {
    name: string;
    driver: string;
    mountpoint: string;
}

export interface DockerImageInfo {
    id: string;
    repository: string;
    tag: string;
    size: string;
    createdSince: string;
}

/** What an image's Dockerfile already declares (`VOLUME`/`EXPOSE`/`ENV`) — a
 *  cheap `docker image inspect` away, no pull/run needed. Powers the Compose
 *  visual editor's "suggested volumes/ports/environment" pickers. Only
 *  populated if the image is already present locally; all empty otherwise —
 *  `present` is what tells the two cases apart, so the editor can offer a pull
 *  instead of silently showing no suggestions. */
export interface ImageDefaults {
    /** Whether the image is pulled on the host. False means the three lists are
     *  empty because nothing could be inspected, not because the image declares
     *  nothing. */
    present: boolean;
    volumes: string[];
    ports: { port: number; protocol: "tcp" | "udp" }[];
    env: { key: string; value: string }[];
}

export interface DockerState {
    available: boolean;
    error?: string;
    containers: ContainerInfo[];
    volumes: DockerVolumeInfo[];
    images: DockerImageInfo[];
}

export type ContainerAction = "start" | "stop" | "restart" | "remove" | "pause" | "unpause";

/** A compose stack derived from container labels. */
export interface DockerStack {
    project: string;
    /** Total containers belonging to the stack. */
    containers: number;
    /** Containers currently running. */
    running: number;
    /** com.docker.compose.project.config_files label, if present. */
    configFiles: string;
    /** Distinct container states present in the stack. */
    states: string[];
}

export interface DockerStacksState {
    available: boolean;
    error?: string;
    stacks: DockerStack[];
}

export interface DockerMount {
    type: string;
    source: string;
    destination: string;
}

/** `docker inspect` of a single container, distilled for the detail view. */
export interface DockerContainerDetail {
    id: string;
    name: string;
    image: string;
    state: string;
    status: string;
    created: string;
    command: string;
    ports: string[];
    mounts: DockerMount[];
    env: string[];
    networks: string[];
    restartPolicy: string;
    /** Container labels (`Config.Labels`), as key/value pairs, sorted by key. */
    labels: { key: string; value: string }[];
    /** Pretty-printed raw `docker inspect` JSON. */
    raw: string;
}

export interface DockerVolumeDetail {
    name: string;
    driver: string;
    mountpoint: string;
    /** Containers that mount this volume. */
    attached: { id: string; name: string }[];
    createdAt?: string;
    labels?: string;
}

export interface DockerOverview {
    available: boolean;
    error?: string;
    containersRunning: number;
    containersTotal: number;
    stacks: number;
    volumes: number;
    images: number;
    /** Disk usage from `docker system df`. */
    df?: {
        images: string;
        containers: string;
        volumes: string;
        buildCache: string;
    };
}

export type StackAction = "start" | "stop" | "restart" | "down";
export type ImageAction = "remove";

/** Result of a one-shot `docker exec`/`docker compose exec` command (the quick
 *  exec box on the container/app pages) — same shape as the agent's internal
 *  `ExecResult`, not a full interactive session. */
export interface DockerExecResult {
    stdout: string;
    stderr: string;
    code: number;
}


/**
 * Container/stack lifecycle actions and image pull are deliberately absent —
 * they moved to the task system (`service_action`, `docker_stack_action`,
 * `docker_container_action`, `docker_image_pull` kinds via `runTask`) for run
 * history + logs.
 */
export interface DockerOperations {
    list: { data: { serverId: string }; response: DockerState };
    containerLogs: { data: { serverId: string; containerId: string; timestamps?: boolean } & LogQuery; response: { logs: string } };
    overview: { data: { serverId: string }; response: DockerOverview };
    containerInspect: { data: { serverId: string; containerId: string }; response: DockerContainerDetail };
    // One-shot, non-interactive command run inside a running container/service —
    // `docker exec`/`docker compose exec` under the hood, not an attached shell.
    containerExec: { data: { serverId: string; containerId: string; command: string }; response: DockerExecResult };
    volumeInspect: { data: { serverId: string; name: string }; response: DockerVolumeDetail };
    volumeRemove: { data: { serverId: string; name: string }; response: void };
    imageAction: { data: { serverId: string; imageId: string; action: ImageAction }; response: void };
    // Volume/port/env suggestions from what the image's Dockerfile already
    // declares — empty fields if the image isn't pulled locally yet.
    imageDefaults: { data: { serverId: string; image: string }; response: ImageDefaults };
}
