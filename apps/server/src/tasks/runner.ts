import { randomUUID } from "node:crypto";
import type { TaskLogLine, TaskRun, TaskSpec, TaskTrigger } from "@central/shared";
import type { AppStore } from "../features/apps/apps";
import type { Fleet } from "../fleet";
import { TaskStore } from "./store";
import { type TaskCtx, type TaskHandlers, runTaskSpec } from "./types";

/**
 * Owns the lifecycle of a task run: status transitions, the resolved agent +
 * cancellation context handlers run with, persistence via {@link TaskStore}, and
 * broadcasting each change as a `taskUpdate` event. Handlers (in ./types) stay
 * small and pure — they just take a ctx + spec and return a result.
 */
/** Log lines kept per run, oldest dropped first once a run exceeds this. */
const MAX_LOG_LINES = 2000;

export class TaskRunner {
    /** In-memory log buffers, keyed by run id. Not persisted in this slice —
     *  lost on control-plane restart, same as any other in-flight state. */
    private logs = new Map<string, TaskLogLine[]>();

    constructor(
        private readonly store: TaskStore,
        private readonly fleet: Fleet,
        private readonly apps: AppStore,
        private readonly onUpdate: (run: TaskRun) => void,
        private readonly onLog: (taskId: string, line: TaskLogLine) => void,
        private readonly handlers: TaskHandlers,
    ) { }

    /** Log lines buffered for a run so far, oldest first. */
    getLogs(id: string): TaskLogLine[] {
        return this.logs.get(id) ?? [];
    }

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
            target: run.target,
            fleet: this.fleet,
            apps: this.apps,
            log: (text, stream) => {
                const line: TaskLogLine = { ts: Date.now(), text, stream };
                const buf = this.logs.get(run.id) ?? [];
                buf.push(line);
                if (buf.length > MAX_LOG_LINES) {
                    buf.splice(0, buf.length - MAX_LOG_LINES);
                }
                this.logs.set(run.id, buf);
                this.onLog(run.id, line);
            },
        };

        try {
            // Resolve the target host inside the try so an unknown/offline target
            // surfaces as a failed run rather than throwing out of the runner.
            ctx.agent = run.target === null ? null : this.fleet.get(run.target);
            run.result = await runTaskSpec(this.handlers, run.spec, ctx);
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
