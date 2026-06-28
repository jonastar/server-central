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

/** Run something on a shell. */
export interface TaskCmd {
    kind: "cmd";
    command: string;
}

/** Discover the external (WAN) IP via STUN. */
export interface TaskFindWanIp {
    kind: "find_wan_ip";
}

/** Every task kind. Add a variant here + a handler + a result variant. */
export type TaskSpec = TaskCmd | TaskFindWanIp;

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

export type TaskResult = TaskCmdResult | TaskFindWanIpResult;

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
