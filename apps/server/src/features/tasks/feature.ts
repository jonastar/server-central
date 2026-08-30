import type { TaskLogLine, TaskRun, TaskSpec } from "@central/shared";
import { TASK_KIND_PERMISSIONS, canRunTask } from "@central/shared";
import type { AuthContext } from "../../auth";
import type { Feature, FeatureApiHandlers } from "../../feature";
import type { TaskRunner } from "../../tasks/runner";
import type { TaskStore } from "../../tasks/store";

// The uniform task envelope — run history, typed last-result, run-now. The engine
// itself (runner, store, the kind→handler map) stays at src/tasks/, since every
// feature contributes kinds to it; this is only its API slice.

export function createTasksFeature(tasks: TaskRunner, store: TaskStore): Feature<TasksOps> {
    return {
        descriptor: {
            id: "tasks",
            name: "Tasks",
            description: "Run history and live logs for every long-running action across the fleet.",
            experimental: false,
        },
        apiHandlers() {
            return tasksApiHandlers(tasks, store);
        },
    };
}

export type TasksOps = "runTask" | "listTasks" | "getTask" | "getTaskLogs";

export function tasksApiHandlers(tasks: TaskRunner, store: TaskStore): FeatureApiHandlers<TasksOps> {
    return {
        async handleRunTask(data: { spec: TaskSpec; target: string | null }, ctx?: AuthContext): Promise<{ id: string }> {
            // `panel.tasks.run` got the caller as far as this handler; it says
            // nothing about *which* kind, and the kinds range from restarting a
            // container to running arbitrary shell. The spec arrives off the
            // wire, so an unrecognised kind is refused rather than run.
            const required = TASK_KIND_PERMISSIONS[data.spec.kind];
            if (!required || !canRunTask(ctx?.user, data.spec.kind)) {
                throw new Error(`Requires the "${required ?? "unknown"}" permission`);
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
