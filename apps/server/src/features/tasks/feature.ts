import type { TaskLogLine, TaskRun, TaskSpec } from "@central/shared";
import { requireOwner, type AuthContext } from "../../auth";
import type { Feature, FeatureApiHandlers, TaskKind } from "../../feature";
import type { TaskRunner } from "../../tasks/runner";
import type { TaskStore } from "../../tasks/store";

// The uniform task envelope — run history, typed last-result, run-now. The engine
// itself (runner, store, the kind→handler map) stays at src/tasks/, since every
// feature contributes kinds to it; this is only its API slice.

export function createTasksFeature(tasks: TaskRunner, store: TaskStore, ownerOnlyKinds: ReadonlySet<TaskKind>): Feature<TasksOps> {
    return {
        descriptor: {
            id: "tasks",
            name: "Tasks",
            description: "Run history and live logs for every long-running action across the fleet.",
            experimental: false,
        },
        apiHandlers() {
            return tasksApiHandlers(tasks, store, ownerOnlyKinds);
        },
    };
}

export type TasksOps = "runTask" | "listTasks" | "getTask" | "getTaskLogs";

/**
 * `ownerOnlyKinds` is composed from the features' own `ownerOnlyTaskKinds`
 * declarations rather than listed here, so the gate lives next to the code that
 * knows why a kind is dangerous (ZFS pool/vdev mutations, today) and this slice
 * needs no per-domain imports.
 */
export function tasksApiHandlers(tasks: TaskRunner, store: TaskStore, ownerOnlyKinds: ReadonlySet<TaskKind>): FeatureApiHandlers<TasksOps> {
    return {
        async handleRunTask(data: { spec: TaskSpec; target: string | null }, ctx?: AuthContext): Promise<{ id: string }> {
            if (ownerOnlyKinds.has(data.spec.kind)) {
                requireOwner(ctx);
            }
            const run = await tasks.start(data.spec, data.target, { kind: "manual", userId: ctx?.user?.id });
            return { id: run.id };
        },

        async handleListTasks(data: { target?: string | null; kind?: TaskSpec["kind"]; limit?: number }): Promise<TaskRun[]> {
            return store.list(data);
        },

        async handleGetTask(data: { id: string }): Promise<TaskRun | null> {
            return store.get(data.id);
        },

        async handleGetTaskLogs(data: { id: string }): Promise<TaskLogLine[]> {
            return tasks.getLogs(data.id);
        },
    };
}
