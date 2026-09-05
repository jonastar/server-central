import type { TaskLogLine, TaskRun, TaskSpec } from "@central/shared";
import { TASK_KIND_PERMISSIONS, canRunTask } from "@central/shared";
import type { AuthContext } from "../../auth";
import { defineFeature } from "../../feature";
import type { TaskRunner } from "../../tasks/runner";
import type { TaskStore } from "../../tasks/store";

// The uniform task envelope — run history, typed last-result, run-now. The engine
// itself (runner, store, the kind→handler map) stays at src/tasks/, since every
// feature contributes kinds to it; this is only its API slice.

export const createTasksFeature = (tasks: TaskRunner, store: TaskStore) => defineFeature({
    id: "tasks",
    name: "Tasks",
    description: "Run history and live logs for every long-running action across the fleet.",
    experimental: false,
    ops: {
        async run(data, ctx?: AuthContext) {
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

        async list(data) {
            return store.list(data);
        },

        async get(data) {
            return store.get(data.id);
        },

        async getLogs(data) {
            return tasks.getLogs(data.id);
        },
    },
});


