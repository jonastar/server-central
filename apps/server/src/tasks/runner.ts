import { randomUUID } from "node:crypto";
import type { TaskLogLine, TaskRun, TaskSpec, TaskTrigger } from "@central/shared";
import type { Fleet } from "../fleet";
import { TaskStore } from "./store";
import { type TaskCtx, runTaskSpec } from "./types";

/**
 * Owns the lifecycle of a task run: status transitions, the resolved agent +
 * cancellation context handlers run with, persistence via {@link TaskStore}, and
 * broadcasting each change as a `taskUpdate` event. Handlers (in ./types) stay
 * small and pure — they just take a ctx + spec and return a result.
 */
export class TaskRunner {
    /** In-memory log buffers, keyed by run id. Not persisted in this slice. */
    private logs = new Map<string, TaskLogLine[]>();

    constructor(
        private readonly store: TaskStore,
        private readonly fleet: Fleet,
        private readonly onUpdate: (run: TaskRun) => void,
    ) { }

    /**
     * Create a run (status `pending`), kick off its execution in the background,
     * and return the run immediately — task semantics, not request/response.
     */
    async start(spec: TaskSpec, target: string | null, trigger: TaskTrigger): Promise<TaskRun> {
        const run: TaskRun = {
            id: randomUUID(),
            spec,
            target,
            status: "pending",
            trigger,
            createdAt: Date.now(),
        };
        await this.save(run);
        void this.execute(run);
        return run;
    }

    private async execute(run: TaskRun): Promise<void> {
        run.status = "running";
        run.startedAt = Date.now();
        await this.save(run);

        const controller = new AbortController();
        const ctx: TaskCtx = {
            signal: controller.signal,
            agent: null,
            log: (text, stream) => {
                const line: TaskLogLine = { ts: Date.now(), text, stream };
                const buf = this.logs.get(run.id) ?? [];
                buf.push(line);
                this.logs.set(run.id, buf);
            },
        };

        try {
            // Resolve the target host inside the try so an unknown/offline target
            // surfaces as a failed run rather than throwing out of the runner.
            ctx.agent = run.target === null ? null : this.fleet.get(run.target);
            run.result = await runTaskSpec(run.spec, ctx);
            run.status = "succeeded";
        } catch (err) {
            run.status = "failed";
            run.error = err instanceof Error ? err.message : String(err);
        } finally {
            run.finishedAt = Date.now();
            await this.save(run);
        }
    }

    private async save(run: TaskRun): Promise<void> {
        await this.store.put(run);
        this.onUpdate(run);
    }
}
