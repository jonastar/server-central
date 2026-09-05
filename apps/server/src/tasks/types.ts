import type {
    TaskCmd,
    TaskCmdResult,
    TaskExec,
    TaskExecResult,
    TaskFindWanIp,
    TaskFindWanIpResult,
    TaskDebugFake,
    TaskDebugFakeResult,
    TaskDockerComposeAction,
    TaskDockerComposeActionResult,
    TaskDockerContainerAction,
    TaskDockerContainerActionResult,
    TaskDockerImagePull,
    TaskDockerImagePullResult,
    TaskDockerStackAction,
    TaskDockerStackActionResult,
    TaskResult,
    TaskServiceAction,
    TaskServiceActionResult,
    TaskSpec,
    TaskUpdateAgent,
    TaskUpdateAgentResult,
    TaskZfsDatasetCreate,
    TaskZfsDatasetCreateResult,
    TaskZfsDatasetDestroy,
    TaskZfsDatasetDestroyResult,
    TaskZfsDeviceReplace,
    TaskZfsDeviceReplaceResult,
    TaskZfsPoolCreate,
    TaskZfsPoolCreateResult,
    TaskZfsPoolDestroy,
    TaskZfsPoolDestroyResult,
    TaskZfsPoolExport,
    TaskZfsPoolExportResult,
    TaskZfsPoolImport,
    TaskZfsPoolImportResult,
    TaskZfsScrub,
    TaskZfsScrubResult,
    TaskZfsSnapshotClone,
    TaskZfsSnapshotCloneResult,
    TaskZfsSnapshotCreate,
    TaskZfsSnapshotCreateResult,
    TaskZfsSnapshotDestroy,
    TaskZfsSnapshotDestroyResult,
    TaskZfsSnapshotRollback,
    TaskZfsSnapshotRollbackResult,
    TaskZfsVdevAdd,
    TaskZfsVdevAddResult,
} from "@central/shared";
import type { Fleet } from "../fleet";
import type { HostAgent } from "../host-agent";

// ---- Task handlers: the server half of the spec union ------------------------
//
// The wire types in @central/shared are the spec (`TaskSpec`) and result
// (`TaskResult`) unions. This file is the runtime half: one handler per kind,
// the same shape as the API's operation handlers. The runner narrows on
// `spec.kind` and dispatches to `handlers[kind]`, so every kind is exhaustively
// covered at compile time — add a variant to `TaskSpec` and this map won't
// typecheck until its handler exists.

/**
 * Context a handler runs with.
 *
 * `signal` is the run's cancellation signal. No caller aborts it yet (there is no
 * `cancelTask` operation), so today it never fires — a polling handler should
 * still check it, but must not rely on it as its only exit. `log` is a no-op-cheap append that only matters
 * for kinds that stream output (e.g. `cmd`); the runner persists whatever's
 * reported. `agent` is the resolved target host at the moment the run started,
 * or null for control-plane-local runs. `fleet`/`target` are exposed alongside
 * it only for kinds that need to *re-resolve* the target later in the same run
 * (e.g. `update_agent` waiting for the host to reconnect as a new connection) —
 * most handlers should just use `agent` and never touch `fleet` directly.
 */
export interface TaskCtx {
    log(text: string, stream?: "stdout" | "stderr"): void;
    signal: AbortSignal;
    agent: HostAgent | null;
    target: string | null;
    fleet: Fleet;
}

/**
 * One handler per task kind. The return type is pinned to that kind's result
 * variant, so spec and result can't drift. Mirrors the API's handler map but
 * keyed by `kind` instead of namespace + operation.
 */
export interface TaskHandlers {
    cmd(spec: TaskCmd, ctx: TaskCtx): Promise<TaskCmdResult>;
    exec(spec: TaskExec, ctx: TaskCtx): Promise<TaskExecResult>;
    find_wan_ip(spec: TaskFindWanIp, ctx: TaskCtx): Promise<TaskFindWanIpResult>;
    service_action(spec: TaskServiceAction, ctx: TaskCtx): Promise<TaskServiceActionResult>;
    docker_stack_action(spec: TaskDockerStackAction, ctx: TaskCtx): Promise<TaskDockerStackActionResult>;
    docker_container_action(spec: TaskDockerContainerAction, ctx: TaskCtx): Promise<TaskDockerContainerActionResult>;
    docker_image_pull(spec: TaskDockerImagePull, ctx: TaskCtx): Promise<TaskDockerImagePullResult>;
    docker_compose_action(spec: TaskDockerComposeAction, ctx: TaskCtx): Promise<TaskDockerComposeActionResult>;
    update_agent(spec: TaskUpdateAgent, ctx: TaskCtx): Promise<TaskUpdateAgentResult>;
    debug_fake(spec: TaskDebugFake, ctx: TaskCtx): Promise<TaskDebugFakeResult>;
    zfs_pool_create(spec: TaskZfsPoolCreate, ctx: TaskCtx): Promise<TaskZfsPoolCreateResult>;
    zfs_pool_destroy(spec: TaskZfsPoolDestroy, ctx: TaskCtx): Promise<TaskZfsPoolDestroyResult>;
    zfs_pool_import(spec: TaskZfsPoolImport, ctx: TaskCtx): Promise<TaskZfsPoolImportResult>;
    zfs_pool_export(spec: TaskZfsPoolExport, ctx: TaskCtx): Promise<TaskZfsPoolExportResult>;
    zfs_vdev_add(spec: TaskZfsVdevAdd, ctx: TaskCtx): Promise<TaskZfsVdevAddResult>;
    zfs_device_replace(spec: TaskZfsDeviceReplace, ctx: TaskCtx): Promise<TaskZfsDeviceReplaceResult>;
    zfs_scrub(spec: TaskZfsScrub, ctx: TaskCtx): Promise<TaskZfsScrubResult>;
    zfs_dataset_create(spec: TaskZfsDatasetCreate, ctx: TaskCtx): Promise<TaskZfsDatasetCreateResult>;
    zfs_dataset_destroy(spec: TaskZfsDatasetDestroy, ctx: TaskCtx): Promise<TaskZfsDatasetDestroyResult>;
    zfs_snapshot_create(spec: TaskZfsSnapshotCreate, ctx: TaskCtx): Promise<TaskZfsSnapshotCreateResult>;
    zfs_snapshot_rollback(spec: TaskZfsSnapshotRollback, ctx: TaskCtx): Promise<TaskZfsSnapshotRollbackResult>;
    zfs_snapshot_destroy(spec: TaskZfsSnapshotDestroy, ctx: TaskCtx): Promise<TaskZfsSnapshotDestroyResult>;
    zfs_snapshot_clone(spec: TaskZfsSnapshotClone, ctx: TaskCtx): Promise<TaskZfsSnapshotCloneResult>;
}

/** Every kind below requires a target host — thrown as a normal task failure
 *  if a caller ever sends one with `target: null`. */
export function requireAgent(ctx: TaskCtx, kind: string): HostAgent {
    if (!ctx.agent) {
        throw new Error(`${kind} requires a target host`);
    }
    return ctx.agent;
}

/** Generic dispatch: narrows the result to the spec's kind. */
export type TaskHandlerFor<K extends TaskSpec["kind"]> = TaskHandlers[K];

/** Run a spec by dispatching to its handler. `handlers` is the full registry
 *  composed at boot (core kinds above + every feature's `taskHandlers()`). */
export function runTaskSpec(handlers: TaskHandlers, spec: TaskSpec, ctx: TaskCtx): Promise<TaskResult> {
    // The cast is the one unavoidable bridge between the value-level dispatch and
    // the type-level kind→handler map; each branch is still individually checked.
    return (handlers[spec.kind] as (s: TaskSpec, c: TaskCtx) => Promise<TaskResult>)(spec, ctx);
}
