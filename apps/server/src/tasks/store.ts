import type { TaskResult, TaskRun, TaskSpec } from "@central/shared";
import { readTaskState, writeTaskState } from "../config";

/**
 * A verdict on a run the previous process left mid-flight — for the one kind
 * whose run is *supposed* to outlive its process (`update_control_plane`: the
 * handler exits so the supervisor re-execs the new binary). `null` means "not
 * mine": the store fails the run as interrupted, which is right for every
 * other kind.
 */
export type OrphanResolver = (run: TaskRun) =>
    | { status: "succeeded"; result: TaskResult }
    | { status: "failed"; error: string }
    | null;

/** Most recent runs to keep on disk (and in memory). Older ones are dropped. */
const MAX_RUNS = 200;

/**
 * In-memory store of task runs, backed by `.sc-data/tasks.json`. Keyed by run id
 * and capped at {@link MAX_RUNS} so the file stays bounded. Mirrors the Fleet's
 * load-on-start / persist-on-change pattern.
 */
export class TaskStore {
    private runs = new Map<string, TaskRun>();

    async init(resolveOrphan: OrphanResolver = () => null): Promise<void> {
        for (const run of await readTaskState()) {
            this.runs.set(run.id, run);
        }
        await this.reapOrphans(resolveOrphan);
    }

    /**
     * A run persisted as `pending`/`running` was mid-flight when the control
     * plane last stopped. Nothing can ever complete it — the runner's execution
     * context (abort controller, log buffer, in-flight promise) lives only in
     * the process that started it, and no other process owns these runs — so
     * they'd otherwise sit as "running" forever until pruned. Resolve them once
     * on load instead. `finishedAt` is the reap time, not the true end time,
     * which is unknowable; the error says as much.
     *
     * The exception is a run that was meant to end this way: `resolveOrphan`
     * gets first say, and a verdict from it (either way) stands in for the
     * generic "interrupted" failure.
     */
    private async reapOrphans(resolveOrphan: OrphanResolver): Promise<void> {
        let reaped = 0;
        for (const run of this.runs.values()) {
            if (run.status !== "pending" && run.status !== "running") {
                continue;
            }
            const verdict = resolveOrphan(run);
            if (verdict?.status === "succeeded") {
                run.status = "succeeded";
                run.result = verdict.result;
            } else {
                run.status = "failed";
                run.error = verdict?.error ?? "Interrupted by a control-plane restart; the outcome is unknown.";
            }
            run.finishedAt = Date.now();
            reaped++;
        }
        if (reaped > 0) {
            console.log(`[tasks] resolved ${reaped} orphaned run(s) left over from a previous control-plane process`);
            await this.persist();
        }
    }

    /** Insert or replace a run, then persist. */
    async put(run: TaskRun): Promise<void> {
        this.runs.set(run.id, run);
        this.prune();
        await this.persist();
    }

    get(id: string): TaskRun | null {
        return this.runs.get(id) ?? null;
    }

    /** Runs newest-first, optionally filtered by target and/or kind. */
    list(filter: { target?: string | null; kind?: TaskSpec["kind"]; limit?: number } = {}): TaskRun[] {
        let out = [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
        if (filter.target !== undefined) {
            out = out.filter((r) => r.target === filter.target);
        }
        if (filter.kind !== undefined) {
            out = out.filter((r) => r.spec.kind === filter.kind);
        }
        return filter.limit ? out.slice(0, filter.limit) : out;
    }

    /** Drop the oldest runs once over the cap (Map preserves insertion order). */
    private prune(): void {
        while (this.runs.size > MAX_RUNS) {
            const oldest = this.runs.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.runs.delete(oldest);
        }
    }

    private async persist(): Promise<void> {
        await writeTaskState([...this.runs.values()]);
    }
}
