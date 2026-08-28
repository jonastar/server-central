import type { TaskRun, TaskSpec } from "@central/shared";
import { api } from "./api";
import { connectionManager } from "./connection";
import { taskFeedbackManager, type TaskFeedback } from "./taskFeedback";

/**
 * Run a task and wait until it reaches a terminal status — for call sites that
 * want the old synchronous-await ergonomics (resolve with the finished run,
 * throw on failure/cancellation) while still getting task history + logs for
 * free. Not for kinds where "not ok" is itself a normal result (e.g.
 * `docker_image_pull`) — those resolve either way; check `run.result` instead.
 *
 * The wait rides the events socket (`connectionManager.waitForTask`) rather than
 * polling `getTask`: the run's every status change is already being broadcast to
 * this client to drive the task widget and modal, so asking for it again on a
 * timer was a request per 400ms per in-flight task for information already in
 * hand.
 *
 * `feedback` decides what the operator sees while it works, and defaults to a
 * compact progress card in the corner widget. The default used to be nothing at
 * all, opting in to a full modal per call site — because a page-covering modal
 * on every service restart would be unbearable. A card that dismisses itself on
 * success isn't, so every action can afford to show its work; reserve `"modal"`
 * for runs worth watching (agent update, pool destroy) and `"none"` for call
 * sites that report progress themselves.
 *
 * `onStart` fires with the run's id the moment it exists — before it finishes —
 * so a control can offer its own way into the run while it's still going (see
 * {@link useTaskAction}).
 */
export async function runTaskAndWait(
    spec: TaskSpec,
    target: string | null,
    opts: { feedback?: TaskFeedback; onStart?: (id: string) => void } = {},
): Promise<TaskRun> {
    const { feedback = "progress" } = opts;
    const { id } = await api("runTask", { spec, target });
    opts.onStart?.(id);
    if (feedback !== "none") {
        taskFeedbackManager.track(id, feedback);
    }
    const run = await connectionManager.waitForTask(id);
    if (run.status === "failed") {
        throw new Error(run.error ?? "Task failed");
    }
    if (run.status === "cancelled") {
        throw new Error("Task cancelled");
    }
    return run;
}
