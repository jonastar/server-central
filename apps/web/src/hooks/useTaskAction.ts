import { useCallback, useState } from "react";
import type { TaskRun, TaskSpec } from "@central/shared";
import { canRunTask } from "@central/shared";
import type { TaskFeedback } from "../taskFeedback";
import { useCurrentUser } from "./usePermissions";
import { runTaskAndWait } from "../taskRun";

/**
 * The busy/error bookkeeping every "run a task from this control" site was
 * hand-rolling, in one place — and, more usefully, the state a trigger needs to
 * say something happened.
 *
 * The old shape of this was subtractive: the row dimmed, the buttons went
 * disabled, and nothing appeared. `busyKey` names the control that's waiting
 * (a unit name, a container id — whatever the view keys its rows by) and
 * `taskId` is the run it started, so that control can render a
 * {@link TaskProgress} spinner that also leads to the run's live output.
 *
 * `start` resolves with the finished run, or null if it failed — the error is in
 * `error`, so a caller's follow-up work reads as `if (await start(…)) reload()`.
 *
 * Every task-running control in the app goes through here, which makes it the
 * one place worth checking permission before the request leaves: `runTask` gates
 * on the *kind*, not just the operation, so a control the view forgot to hide
 * would otherwise fail with a server error the operator can do nothing about.
 * `canRun` is exposed so views can hide or disable those controls properly —
 * this guard is the floor, not a substitute.
 */
export function useTaskAction() {
    const user = useCurrentUser();
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [taskId, setTaskId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const start = useCallback(async (
        key: string,
        spec: TaskSpec,
        target: string | null,
        opts?: { feedback?: TaskFeedback },
    ): Promise<TaskRun | null> => {
        if (!canRunTask(user, spec.kind)) {
            setError("You don't have permission to run this.");
            return null;
        }
        setBusyKey(key);
        setTaskId(null);
        setError(null);
        try {
            return await runTaskAndWait(spec, target, { ...opts, onStart: setTaskId });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            return null;
        } finally {
            setBusyKey(null);
            setTaskId(null);
        }
    }, [user]);

    const canRun = useCallback((kind: TaskSpec["kind"]) => canRunTask(user, kind), [user]);

    return { busyKey, taskId, error, setError, start, canRun, busy: busyKey !== null };
}
