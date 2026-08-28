/** How a run this page started is surfaced while it works, and what becomes of
 *  that surface once it lands — a module singleton (same shape as
 *  `connectionManager`) so any component can reach it without threading a
 *  callback down through props. */

import type { TaskRun } from "@central/shared";
import { connectionManager } from "./connection";
import { isTerminalStatus } from "./taskFormat";

/**
 * - `"none"` — nothing on screen; the call site reports for itself.
 * - `"progress"` — a compact live card in the corner widget (the default).
 * - `"modal"` — the full {@link TaskModal}, for actions destructive or slow
 *   enough that watching them *is* the task.
 */
export type TaskFeedback = "none" | "progress" | "modal";

export interface TrackedRun {
    id: string;
    mode: Exclude<TaskFeedback, "none">;
}

export type TaskFeedbackState = {
    /** Which run's full detail modal is open, if any. */
    openTaskId: string | null;
    /** Runs this page started and is still surfacing, oldest first. */
    tracked: TrackedRun[];
};

/** How long a *succeeded* card stays up before dropping itself. Long enough to
 *  register as "that finished", short enough not to become clutter. */
const SUCCESS_HOLD_MS = 4000;
/** The same, for a full modal — shorter, because it's covering the page. */
const MODAL_SUCCESS_HOLD_MS = 1200;

class TaskFeedbackManager {
    private lastListenerId = 0;
    private listeners: Map<number, (state: TaskFeedbackState) => void> = new Map();
    private state: TaskFeedbackState = { openTaskId: null, tracked: [] };

    /** Attached only while something is tracked — nothing to watch otherwise. */
    private connListenerId: number | null = null;
    /** Pending auto-dismissals, keyed by run id, so a run is only scheduled once. */
    private timers = new Map<string, ReturnType<typeof setTimeout>>();

    /** Surface a run this page just started. */
    track(taskId: string, mode: Exclude<TaskFeedback, "none">): void {
        const tracked = [...this.state.tracked.filter((t) => t.id !== taskId), { id: taskId, mode }];
        this.update({ tracked, openTaskId: mode === "modal" ? taskId : this.state.openTaskId });
        this.watchTasks();
    }

    /** Open the full modal for a run — from the widget's expand control, the
     *  tasks list, or a `"modal"` run being tracked. */
    open(taskId: string): void {
        this.update({ openTaskId: taskId });
    }

    close(): void {
        this.update({ openTaskId: null });
    }

    /** Stop surfacing a run: drops its card, leaving the modal alone (closing
     *  the detail view you deliberately opened isn't what dismissing a card
     *  means). */
    dismiss(taskId: string): void {
        const timer = this.timers.get(taskId);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(taskId);
        }
        this.update({ tracked: this.state.tracked.filter((t) => t.id !== taskId) });
        if (this.state.tracked.length === 0 && this.connListenerId !== null) {
            connectionManager.removeListener(this.connListenerId);
            this.connListenerId = null;
        }
    }

    getState(): TaskFeedbackState {
        return this.state;
    }

    addListener(listener: (s: TaskFeedbackState) => void): number {
        const id = this.lastListenerId++;
        this.listeners.set(id, listener);
        listener(this.state);
        return id;
    }

    removeListener(id: number): void {
        this.listeners.delete(id);
    }

    private watchTasks(): void {
        if (this.connListenerId !== null) {
            return;
        }
        this.connListenerId = connectionManager.addListener((s) => this.onTasks(s.tasks));
    }

    /**
     * What happens when a tracked run lands.
     *
     * Success needs no attention, so it takes itself away — that's the
     * "auto-close on complete" half. Failure and cancellation stay put until
     * dismissed: a card that vanished on failure would be strictly worse than no
     * card at all, since you'd have watched something go wrong and lost it.
     */
    private onTasks(tasks: TaskRun[]): void {
        for (const t of this.state.tracked) {
            const run = tasks.find((r) => r.id === t.id);
            if (!run || !isTerminalStatus(run.status) || this.timers.has(t.id)) {
                continue;
            }
            if (run.status !== "succeeded") {
                continue;
            }
            const showingModal = this.state.openTaskId === t.id;
            this.timers.set(t.id, setTimeout(() => {
                // Re-checked rather than trusted from scheduling time: the modal
                // may since have been closed, or reopened on a different run.
                if (this.state.openTaskId === t.id) {
                    this.close();
                }
                this.dismiss(t.id);
            }, showingModal ? MODAL_SUCCESS_HOLD_MS : SUCCESS_HOLD_MS));
        }
    }

    private update(patch: Partial<TaskFeedbackState>): void {
        this.state = { ...this.state, ...patch };
        for (const l of this.listeners.values()) {
            l(this.state);
        }
    }
}

export const taskFeedbackManager = new TaskFeedbackManager();
