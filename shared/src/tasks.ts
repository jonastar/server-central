// ---- Tasks & schedules -------------------------------------------------------
//
// A task is a unit of work the control plane runs, optionally against a host
// agent. The point of the system isn't that tasks are slow — it's the uniform
// envelope: run history, a typed last-result you can inspect for debugging, a
// "run now" button, and schedulability, all shared across kinds.
//
// A task's *spec* is a closed discriminated union keyed by `kind` (server +
// agent ship together, so there's no need for an open registry). Each kind
// declares its own settings inline; the server has one handler per kind, the
// same way the API has one handler per operation. (A future, user-configurable
// version could swap these hand-written settings for zod schemas — the shape
// carries over unchanged.)

import type { ContainerAction, ServiceAction, StackAction } from "./index";

/** Run something on a shell. */
export interface TaskCmd {
    kind: "cmd";
    command: string;
}

/** Discover the external (WAN) IP via STUN. */
export interface TaskFindWanIp {
    kind: "find_wan_ip";
}

/** Start/stop/restart/enable/disable a systemd unit on the target host. */
export interface TaskServiceAction {
    kind: "service_action";
    unit: string;
    action: ServiceAction;
}

/** Start/stop/restart/tear down every container in a compose project. */
export interface TaskDockerStackAction {
    kind: "docker_stack_action";
    project: string;
    action: StackAction;
}

/** Start/stop/restart/pause/unpause/remove a single container. */
export interface TaskDockerContainerAction {
    kind: "docker_container_action";
    containerId: string;
    action: ContainerAction;
}

/** `docker pull` a single image reference. */
export interface TaskDockerImagePull {
    kind: "docker_image_pull";
    ref: string;
}

/** Update an installed agent to the control plane's current AGENT_VERSION
 *  (resolved server-side, not client-supplied). */
export interface TaskUpdateAgent {
    kind: "update_agent";
    /** Bypasses the "already up to date" check (e.g. re-pushing a dev rebuild
     *  whose AGENT_VERSION string didn't change). */
    force?: boolean;
}

/** Every task kind. Add a variant here + a handler + a result variant. */
export type TaskSpec =
    | TaskCmd
    | TaskFindWanIp
    | TaskServiceAction
    | TaskDockerStackAction
    | TaskDockerContainerAction
    | TaskDockerImagePull
    | TaskUpdateAgent;

/** A task kind's discriminant, e.g. "cmd". */
export type TaskKind = TaskSpec["kind"];

// ---- Results -----------------------------------------------------------------
//
// The typed payload of a successful run, keyed by the same `kind` as the spec
// so a run's spec and result always agree. This is a first-class, queryable
// field — not the tail of a log stream.

export interface TaskCmdResult {
    kind: "cmd";
    exitCode: number;
    stdout: string;
    stderr: string;
}

export interface TaskFindWanIpResult {
    kind: "find_wan_ip";
    ip: string | null;
}

/** No extra data beyond confirmation — the run's status/error already says
 *  whether it worked, and the output (if any) is in the run's logs. */
export interface TaskServiceActionResult {
    kind: "service_action";
}

export interface TaskDockerStackActionResult {
    kind: "docker_stack_action";
}

export interface TaskDockerContainerActionResult {
    kind: "docker_container_action";
}

/** Unlike the other docker/service actions, a failed pull isn't an exception —
 *  `ok: false` is a normal (successful-run) result, same as the RPC it replaced. */
export interface TaskDockerImagePullResult {
    kind: "docker_image_pull";
    ok: boolean;
    message: string;
}

/** Confirms the agent acknowledged the update, not that it finished — the
 *  restart into the new binary happens after the run's WS connection drops. */
export interface TaskUpdateAgentResult {
    kind: "update_agent";
}

export type TaskResult =
    | TaskCmdResult
    | TaskFindWanIpResult
    | TaskServiceActionResult
    | TaskDockerStackActionResult
    | TaskDockerContainerActionResult
    | TaskDockerImagePullResult
    | TaskUpdateAgentResult;

// ---- Envelope ----------------------------------------------------------------

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

/** What caused a run to be created. */
export type TaskTrigger =
    | { kind: "manual"; userId?: string }
    | { kind: "schedule"; scheduleId: string }
    /** Internal, spawned by another flow. */
    | { kind: "system" };

/**
 * The uniform record every run carries. `spec` and `result` share a `kind`, so
 * narrowing on `spec.kind` narrows the result too.
 */
export interface TaskRun {
    id: string;
    spec: TaskSpec;
    /** Fleet serverId for host-scoped tasks; null for control-plane-local ones. */
    target: string | null;
    status: TaskStatus;
    /** Present once `status === "succeeded"`. */
    result?: TaskResult;
    /** Present once `status === "failed"`. */
    error?: string;
    trigger: TaskTrigger;
    /** All ms epoch. `startedAt`/`finishedAt` absent until the run reaches them. */
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
}

/**
 * One scoped log line. Fetched/streamed separately from {@link TaskRun} since
 * logs can be large and not every kind emits them. `text` may carry ANSI.
 */
export interface TaskLogLine {
    /** ms epoch */
    ts: number;
    text: string;
    stream?: "stdout" | "stderr";
}

// ---- Schedules ---------------------------------------------------------------

/**
 * A recurring trigger that spawns task runs. It simply holds a {@link TaskSpec}
 * and a cron expression. v1 supports only cron; the model leaves room for event
 * triggers later without reshaping anything.
 */
export interface TaskSchedule {
    id: string;
    /** Display name, e.g. "Nightly WAN IP check". */
    name: string;
    spec: TaskSpec;
    target: string | null;
    /** 5-field cron expression. */
    cron: string;
    enabled: boolean;
    /** All ms epoch. */
    createdAt: number;
    lastRunAt?: number;
    /** Id of the most recent run this schedule spawned, for one-click "last result". */
    lastRunId?: string;
    nextRunAt?: number;
}
