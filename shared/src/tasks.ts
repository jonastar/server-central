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

import type { ContainerAction, ServiceAction, StackAction, ZfsVdevType } from "./index";

/**
 * Run a program directly: `argv[0]` is resolved on PATH and the rest reach it as
 * literal arguments. The form for anything a *caller* builds — a value
 * interpolated into an argument stays a value, so there is no way to get an
 * injection wrong here, and no quoting to remember.
 *
 * Prefer this to {@link TaskCmd} everywhere except a command a person typed.
 */
export interface TaskExec {
    kind: "exec";
    argv: string[];
    /** Working directory, instead of a `cd … &&` prefix. */
    cwd?: string;
    /** Extra environment, layered over the agent's own. */
    env?: Record<string, string>;
}

/**
 * Run a command line through the host's shell.
 *
 * For free text an operator typed, where the pipes, globs and redirects are the
 * point — the task-shaped equivalent of the terminal that `panel.exec` already
 * grants. Code that *assembles* a command wants {@link TaskExec} instead: this
 * one takes a string, so every value put into it is one escaping mistake away
 * from being syntax, and a caller that reaches for the convenient shape
 * shouldn't be the thing that reintroduces command injection.
 */
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

/** Run a compose verb against a registered stack's compose file (`docker
 *  compose -f <path> -p <project> <verb>`), driven from the stack directory
 *  rather than existing container ids — unlike `docker_stack_action`, this
 *  works on a fully-down stack (including one that has never had a container
 *  at all). `action: "up"`
 *  with `pullFirst` is the "Pull & up" control; `action: "pull"` is the same
 *  pull on its own, fetching images without touching what's running. Runs over
 *  the streaming exec, so its output reaches the run's log while it works and a
 *  slow pull isn't cut off at 30s. */
export interface TaskDockerComposeAction {
    kind: "docker_compose_action";
    stackId: string;
    action: "up" | "restart" | "stop" | "down" | "pull";
    /** Ignored when `action` is already "pull". */
    pullFirst?: boolean;
    /** Scope the action to one service instead of the whole project. */
    service?: string;
}

/** Update an installed agent to the control plane's current AGENT_VERSION
 *  (resolved server-side, not client-supplied). */
export interface TaskUpdateAgent {
    kind: "update_agent";
    /** Bypasses the "already up to date" check (e.g. re-pushing a dev rebuild
     *  whose AGENT_VERSION string didn't change). */
    force?: boolean;
}

/** A synthetic run that touches nothing: it just emits log lines for
 *  `durationMs`, then succeeds (or fails, on demand). Exists so the task UI —
 *  the corner widget, the live modal, run history — can be exercised without a
 *  host, a container, or a real action to undo afterwards. Runs on the control
 *  plane; owner-only, and driven from Settings → Debug. */
export interface TaskDebugFake {
    kind: "debug_fake";
    /** Total wall time the run should take. */
    durationMs: number;
    /** Gap between emitted log lines. */
    intervalMs: number;
    /** Finish by throwing instead of succeeding, for exercising the failed-run
     *  presentation. */
    fail?: boolean;
}

// ---- ZFS -------------------------------------------------------------------------
//
// Every ZFS mutation runs as a task, even the ones that finish in milliseconds —
// the point is the audit trail ("who destroyed pool tank, when"), not latency.
// Pool/vdev topology kinds (create/destroy/import/export/vdev add/device replace)
// are gated owner-only by the ZFS feature's `ownerOnlyTaskKinds`; see
// doc/idea_zfs.md's safety model.

/** `devices` are `/dev/disk/by-id/*` paths — never `/dev/sdX`, which isn't
 *  stable across reboots. */
export interface TaskZfsPoolCreate {
    kind: "zfs_pool_create";
    name: string;
    vdevs: { type: ZfsVdevType; devices: string[] }[];
    /** `zpool create -f` — overrides zfs's refusal to use a device that still
     *  carries a stale partition table or filesystem/RAID/ZFS signature from a
     *  previous life (not currently mounted or part of an active pool/array). */
    force?: boolean;
}

export interface TaskZfsPoolDestroy {
    kind: "zfs_pool_destroy";
    name: string;
}

export interface TaskZfsPoolImport {
    kind: "zfs_pool_import";
    name: string;
}

export interface TaskZfsPoolExport {
    kind: "zfs_pool_export";
    name: string;
}

export interface TaskZfsVdevAdd {
    kind: "zfs_vdev_add";
    pool: string;
    vdev: { type: ZfsVdevType; devices: string[] };
    /** `zpool add -f` — see {@link TaskZfsPoolCreate.force}. */
    force?: boolean;
}

export interface TaskZfsDeviceReplace {
    kind: "zfs_device_replace";
    pool: string;
    oldDevice: string;
    newDevice: string;
}

export interface TaskZfsScrub {
    kind: "zfs_scrub";
    pool: string;
    action: "start" | "stop";
}

export interface TaskZfsDatasetCreate {
    kind: "zfs_dataset_create";
    /** Parent dataset or pool the new one is created under. */
    parent: string;
    name: string;
    type: "filesystem" | "volume";
    /** Required for type "volume" (zvol). */
    volsizeBytes?: number;
    properties?: Record<string, string>;
}

export interface TaskZfsDatasetDestroy {
    kind: "zfs_dataset_destroy";
    name: string;
    recursive: boolean;
}

export interface TaskZfsSnapshotCreate {
    kind: "zfs_snapshot_create";
    dataset: string;
    name: string;
    recursive: boolean;
}

export interface TaskZfsSnapshotRollback {
    kind: "zfs_snapshot_rollback";
    snapshot: string;
    /** Destroy intervening snapshots newer than the target (zfs rollback -r).
     *  The UI must show their count before setting this. */
    destroyLater: boolean;
}

export interface TaskZfsSnapshotDestroy {
    kind: "zfs_snapshot_destroy";
    snapshot: string;
}

export interface TaskZfsSnapshotClone {
    kind: "zfs_snapshot_clone";
    snapshot: string;
    target: string;
}

/** Every task kind. Add a variant here + a handler + a result variant. */
export type TaskSpec =
    | TaskCmd
    | TaskExec
    | TaskFindWanIp
    | TaskServiceAction
    | TaskDockerStackAction
    | TaskDockerContainerAction
    | TaskDockerImagePull
    | TaskDockerComposeAction
    | TaskUpdateAgent
    | TaskDebugFake
    | TaskZfsPoolCreate
    | TaskZfsPoolDestroy
    | TaskZfsPoolImport
    | TaskZfsPoolExport
    | TaskZfsVdevAdd
    | TaskZfsDeviceReplace
    | TaskZfsScrub
    | TaskZfsDatasetCreate
    | TaskZfsDatasetDestroy
    | TaskZfsSnapshotCreate
    | TaskZfsSnapshotRollback
    | TaskZfsSnapshotDestroy
    | TaskZfsSnapshotClone;

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

export interface TaskExecResult {
    kind: "exec";
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

export interface TaskDockerComposeActionResult {
    kind: "docker_compose_action";
}

/** Confirms the agent acknowledged the update, not that it finished — the
 *  restart into the new binary happens after the run's WS connection drops. */
export interface TaskUpdateAgentResult {
    kind: "update_agent";
}

export interface TaskDebugFakeResult {
    kind: "debug_fake";
    /** How many log lines the run emitted. */
    lines: number;
}

// No extra data beyond confirmation for any ZFS mutation — status/error on the
// run already says whether it worked, and stdout/stderr streams to the run's logs.

export interface TaskZfsPoolCreateResult {
    kind: "zfs_pool_create";
}

export interface TaskZfsPoolDestroyResult {
    kind: "zfs_pool_destroy";
}

export interface TaskZfsPoolImportResult {
    kind: "zfs_pool_import";
}

export interface TaskZfsPoolExportResult {
    kind: "zfs_pool_export";
}

export interface TaskZfsVdevAddResult {
    kind: "zfs_vdev_add";
}

export interface TaskZfsDeviceReplaceResult {
    kind: "zfs_device_replace";
}

export interface TaskZfsScrubResult {
    kind: "zfs_scrub";
}

export interface TaskZfsDatasetCreateResult {
    kind: "zfs_dataset_create";
}

export interface TaskZfsDatasetDestroyResult {
    kind: "zfs_dataset_destroy";
}

export interface TaskZfsSnapshotCreateResult {
    kind: "zfs_snapshot_create";
}

export interface TaskZfsSnapshotRollbackResult {
    kind: "zfs_snapshot_rollback";
}

export interface TaskZfsSnapshotDestroyResult {
    kind: "zfs_snapshot_destroy";
}

export interface TaskZfsSnapshotCloneResult {
    kind: "zfs_snapshot_clone";
}

export type TaskResult =
    | TaskCmdResult
    | TaskExecResult
    | TaskFindWanIpResult
    | TaskServiceActionResult
    | TaskDockerStackActionResult
    | TaskDockerContainerActionResult
    | TaskDockerImagePullResult
    | TaskDockerComposeActionResult
    | TaskUpdateAgentResult
    | TaskDebugFakeResult
    | TaskZfsPoolCreateResult
    | TaskZfsPoolDestroyResult
    | TaskZfsPoolImportResult
    | TaskZfsPoolExportResult
    | TaskZfsVdevAddResult
    | TaskZfsDeviceReplaceResult
    | TaskZfsScrubResult
    | TaskZfsDatasetCreateResult
    | TaskZfsDatasetDestroyResult
    | TaskZfsSnapshotCreateResult
    | TaskZfsSnapshotRollbackResult
    | TaskZfsSnapshotDestroyResult
    | TaskZfsSnapshotCloneResult;

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
