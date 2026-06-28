# Task system — design spec

Status: **first slice implemented** (`find_wan_ip`). Schedules, logs, cancellation,
and agent-targeted kinds are designed here but **not yet built** — those sections
are marked _(deferred)_.

---

## 1. Motivation

Most control-plane actions are plain request/response RPC: the handler calls the
agent, awaits, and returns a value (see `apps/server/src/handler.ts`). That's the
right shape for reads and quick mutations and it stays that way.

A task is for work that benefits from a **uniform envelope** rather than for work
that is merely slow. The envelope buys, for every task kind at once:

- **run history** — every invocation is a persisted record, not a fire-and-forget call;
- **typed last-result inspection** — "what did the last run actually see?" for debugging;
- **run-now** — a standardised affordance any kind gets for free;
- **schedulability** _(deferred)_ — the same kind can be triggered on a cron.

The value is the envelope, not the duration. A sub-second STUN check and a
multi-minute agent update are the *same shape*; they differ only in which
**capabilities** (logs, resume-across-reconnect) they opt into.

### What is / isn't a task

A mutation or probe you'd want history of, a last-result for, or to schedule →
task. A pure read (`listDir`, `dockerOverview`, `getProcesses`) → stays RPC; you
don't schedule a directory listing or inspect "the last one".

---

## 2. Ownership model

**Tasks are always owned by the control plane.** An agent is just a worker for
kinds that target a host. This is deliberate, and the agent-update case forces
it: an update *kills the agent's own WS connection mid-run*, so the run record
cannot live on the agent. Keeping the store on the control plane also means
history and schedules survive agent restarts.

- A task with `target: string` runs against that fleet host (resolved to a
  `HostAgent` by the runner before the handler is called).
- A task with `target: null` is **control-plane-local** (e.g. `find_wan_ip`'s
  STUN runs from the control plane itself).

---

## 3. Data model

All wire types live in `@central/shared` (`shared/src/tasks.ts`). The runtime
handlers live server-side (`apps/server/src/tasks/`).

### 3.1 Spec — a closed discriminated union

The set of task kinds is closed (server + agent ship together from one monorepo,
so there's no need for an open registry). Each kind declares its settings inline,
keyed by `kind`:

```ts
export interface TaskCmd { kind: "cmd"; command: string; }
export interface TaskFindWanIp { kind: "find_wan_ip"; }

export type TaskSpec = TaskCmd | TaskFindWanIp;
export type TaskKind = TaskSpec["kind"];
```

> A future, user-configurable version could swap the hand-written settings for
> zod schemas (`settings: z.infer<typeof schema>`) — the shape carries over
> unchanged. Not needed now.

### 3.2 Result — a parallel union on the same `kind`

The typed payload of a *successful* run, keyed by the same `kind` as the spec so
a run's spec and result always agree. This is a **first-class, queryable field**
— not the tail of a log stream. It's the half of the system that answers "what
did the last run see?".

```ts
export interface TaskCmdResult { kind: "cmd"; exitCode: number; stdout: string; stderr: string; }
export interface TaskFindWanIpResult { kind: "find_wan_ip"; ip: string | null; }

export type TaskResult = TaskCmdResult | TaskFindWanIpResult;
```

### 3.3 Envelope — `TaskRun`

The uniform record every run carries. `spec` and `result` share a `kind`, so
narrowing on `spec.kind` narrows the result too.

```ts
export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export type TaskTrigger =
    | { kind: "manual"; userId?: string }
    | { kind: "schedule"; scheduleId: string }   // deferred
    | { kind: "system" };                          // internal (e.g. install flow)

export interface TaskRun {
    id: string;
    spec: TaskSpec;
    target: string | null;        // fleet serverId, or null for control-plane-local
    status: TaskStatus;
    result?: TaskResult;          // present once succeeded
    error?: string;               // present once failed
    trigger: TaskTrigger;
    createdAt: number;            // all ms epoch
    startedAt?: number;
    finishedAt?: number;
}
```

### 3.4 Logs — `TaskLogLine` _(deferred)_

A scoped, optionally-ANSI log line, fetched/streamed separately from the
envelope because logs can be large and most kinds emit none. The runner already
buffers these in memory (`apps/server/src/tasks/runner.ts`), but they are not yet
persisted, streamed, or exposed via an API op.

```ts
export interface TaskLogLine { ts: number; text: string; stream?: "stdout" | "stderr"; }
```

### 3.5 Schedule — `TaskSchedule` _(deferred)_

A recurring trigger that spawns runs. It simply holds a `TaskSpec` + a cron
expression. v1 will support only cron; the model leaves room for event triggers
("on agent connect", "disk > 90%") later as another variant, not a new entity.

```ts
export interface TaskSchedule {
    id: string;
    name: string;                 // "Nightly WAN IP check"
    spec: TaskSpec;
    target: string | null;
    cron: string;                 // 5-field
    enabled: boolean;
    createdAt: number;
    lastRunAt?: number;
    lastRunId?: string;           // most recent spawned run, for one-click "last result"
    nextRunAt?: number;
}
```

---

## 4. The handler layer (envelope vs capability split)

The wire types are the *spec* and *result*. The server half is **one handler per
kind**, the same shape as the API's operation handlers
(`apps/server/src/tasks/types.ts`):

```ts
export interface TaskCtx {
    log(text: string, stream?: "stdout" | "stderr"): void;  // no-op-cheap; only matters for logs-capable kinds
    signal: AbortSignal;                                     // cooperative cancellation (deferred consumer)
    agent: HostAgent | null;                                 // resolved target, or null; handlers never touch the fleet
}

export interface TaskHandlers {
    cmd(spec: TaskCmd, ctx: TaskCtx): Promise<TaskCmdResult>;
    find_wan_ip(spec: TaskFindWanIp, ctx: TaskCtx): Promise<TaskFindWanIpResult>;
}
```

Each handler's return type is pinned to that kind's result variant, so spec and
result can't drift. `runTaskSpec(spec, ctx)` narrows on `spec.kind` and
dispatches — adding a variant to `TaskSpec` won't typecheck until its handler
exists.

**Capabilities are declarative, not baked into the handler.** A kind that emits
no logs simply never calls `ctx.log`; the UI shows no log viewer for it. STUN is
the zero-capability case: envelope + typed result, nothing else.

### Adding a kind = three spots

1. spec variant in `TaskSpec` (`shared/src/tasks.ts`)
2. result variant in `TaskResult` (`shared/src/tasks.ts`)
3. handler in `taskHandlers` (`apps/server/src/tasks/types.ts`)

---

## 5. Runner lifecycle

`TaskRunner` (`apps/server/src/tasks/runner.ts`) owns everything around the
handler so handlers stay small and pure:

```
start(spec, target, trigger)
  → create TaskRun { status: "pending" }     → save + broadcast
  → (background) execute:
      status = "running", startedAt           → save + broadcast
      resolve agent = target===null ? null : fleet.get(target)   // inside try
      result = await runTaskSpec(spec, ctx)
      status = "succeeded"                     (or "failed" + error on throw)
      finishedAt                               → save + broadcast
```

`start` returns the `pending` run **immediately** (task semantics, not
request/response); execution proceeds in the background. The target is resolved
*inside* the try so an unknown/offline target surfaces as a `failed` run rather
than throwing out of the runner.

---

## 6. Persistence

`TaskStore` (`apps/server/src/tasks/store.ts`) mirrors the Fleet's
load-on-start / persist-on-change pattern:

- In-memory `Map<id, TaskRun>`, persisted to `.sc-data/tasks.json` (via
  `readTaskState`/`writeTaskState` in `config.ts`, atomic write).
- Newest-first listing with optional `target` / `kind` / `limit` filters.
- Capped at `MAX_RUNS = 200`; oldest are pruned before each write so the file
  stays bounded.

---

## 7. API & event surface

### Implemented (HTTP ops, `CentralApiOperations`)

| Op | Data | Response |
| --- | --- | --- |
| `runTask` | `{ spec: TaskSpec; target: string \| null }` | `{ id: string }` |
| `listTasks` | `{ target?; kind?; limit? }` | `TaskRun[]` |
| `getTask` | `{ id: string }` | `TaskRun \| null` |

### Implemented (events, `ApiEvent`)

- `init` payload now carries `tasks: TaskRun[]` so the web client has run history
  on connect.
- `taskUpdate: TaskRun` — broadcast on every status change (the client upserts by id).

### Web client

`connection.ts` tracks `tasks` (seeded from `init`, upserted on `taskUpdate`).
`SettingsView` renders an "External (WAN) IP" card: **Check now** → `runTask`
with `{ kind: "find_wan_ip" }`, showing the latest run's IP + timestamp, live.

---

## 8. Deferred work (designed, not built)

### 8.1 Schedules

The biggest deferred piece. Shape:

- **Store**: `TaskSchedule[]` persisted to `.sc-data/schedules.json`, same
  pattern as the task store.
- **Scheduler**: a single timer loop on the control plane that, on each tick,
  finds due schedules (`nextRunAt <= now && enabled`), calls
  `runner.start(schedule.spec, schedule.target, { kind: "schedule", scheduleId })`,
  then recomputes `nextRunAt` from the cron expression. Records `lastRunAt` /
  `lastRunId` on the schedule.
- **Catch-up policy**: on startup, a schedule whose `nextRunAt` is in the past
  fires **once** (not once per missed interval), then resumes its cadence.
- **API ops** (already designed, removed from the map until built):
  `listSchedules`, `createSchedule { name, spec, target, cron }`,
  `updateSchedule { id, name?, spec?, cron?, enabled? }`, `deleteSchedule`,
  `runScheduleNow` (spawn a run immediately — the schedule's own run-now).
- **UI**: a schedules table; each row shows cadence, enabled toggle, last result
  (via `lastRunId`), and run-now. A "Schedule…" action on any run-now-able kind.

Naming note: the model is CI-like — a **schedule** spawns **runs**. Keep the two
entities distinct; don't fold a schedule into the run.

### 8.2 Logs + log streaming

`TaskLogLine` and the runner's in-memory buffer exist; still needed:
persistence (or a bounded ring), a `getTaskLogs { id }` op, a `taskLog
{ taskId, lines }` event for live tailing, and reuse of the existing
`LogViewer` component (ANSI + find) in a per-run view. Driven by
`capabilities.logs`-style metadata so the UI only shows a viewer for kinds that
emit logs.

### 8.3 Cancellation

`ctx.signal` (an `AbortController`) is already threaded through; still needed: a
`cancelTask { id }` op that aborts the controller and transitions the run to
`cancelled`, plus handler cooperation (honor `signal` in long operations).

### 8.4 Agent-targeted kinds

`cmd` is defined end-to-end but currently only meaningful against
`ctx.agent` (control-plane `exec` is a stub). The first real agent-targeted
migration exercises `fleet.get(target)` resolution and offline-target failure
(which already surfaces as a `failed` run).

Candidate next kinds, per `next.md`: per-node STUN (`find_wan_ip` with a non-null
target), start/stop services, backups.

### 8.5 Resume across reconnect

The genuinely hard capability, needed for **agent update**: `run` kicks off the
update and the WS drops; the run stays `running` until the agent reconnects, at
which point the runner re-attaches and drives the kind's `resume(ctx, run)` to a
terminal status. This is *why* the store is control-plane-owned. A
`ResumableTaskType`-style opt-in interface; only kinds that can outlive a
disconnect implement it.

---

## 9. File map

| File | Role |
| --- | --- |
| `shared/src/tasks.ts` | Wire types: `TaskSpec`, `TaskResult`, `TaskRun`, `TaskLogLine`, `TaskSchedule` |
| `shared/src/index.ts` | API ops (`runTask`/`listTasks`/`getTask`) + `taskUpdate` event + `init.tasks` |
| `apps/server/src/tasks/types.ts` | `TaskCtx`, `TaskHandlers`, `taskHandlers`, `runTaskSpec` |
| `apps/server/src/tasks/runner.ts` | `TaskRunner` — lifecycle, broadcast |
| `apps/server/src/tasks/store.ts` | `TaskStore` — in-memory + `.sc-data/tasks.json`, capped |
| `apps/server/src/config.ts` | `readTaskState` / `writeTaskState` |
| `apps/server/src/handler.ts` | `handleRunTask` / `handleListTasks` / `handleGetTask` |
| `apps/web/src/connection.ts` | Client task state (seed + upsert) |
| `apps/web/src/components/SettingsView.tsx` | WAN IP card (first consumer) |
