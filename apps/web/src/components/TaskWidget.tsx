import { useEffect } from "react";
import type { TaskLogLine, TaskRun } from "@central/shared";
import { api } from "../api";
import { connectionManager } from "../connection";
import { useConnection } from "../hooks/useConnection";
import { useTaskFeedback } from "../hooks/useTaskFeedback";
import { resultSummary, serverLabel, specSummary, STATUS_LABEL, statusTone } from "../taskFormat";
import { taskFeedbackManager } from "../taskFeedback";
import { cx } from "../utils";
import styles from "./TaskWidget.module.css";
import shared from "../styles/shared.module.css";

const PREVIEW_LINES = 6;

/**
 * The compact live view of runs *this page started* — cards stacked under the
 * top bar's Tasks button, which is where task state lives now.
 *
 * Scoped deliberately to tracked runs. Anything running anywhere (another tab, a
 * schedule) is in the Tasks button's panel and its count; popping a card for it
 * would be someone else's work interrupting yours. A tracked card appears the
 * moment you act, lingers a beat on success, and stays until dismissed on
 * failure — which is what makes this, and not a separate toast, the place a
 * failed action is reported.
 */
export function TaskWidget() {
    const { tasks, taskLogs, servers } = useConnection();
    const { tracked } = useTaskFeedback();

    const cards = tracked
        .map((t) => tasks.find((run) => run.id === t.id))
        .filter((run): run is TaskRun => run !== undefined);
    const cardIds = cards.map((c) => c.id).join(",");

    // Seed logs for any card this client hasn't fetched yet (a run started
    // before this tab connected, say).
    useEffect(() => {
        for (const id of cardIds ? cardIds.split(",") : []) {
            if (taskLogs[id] === undefined) {
                void api("getTaskLogs", { id }).then(
                    (lines) => connectionManager.seedTaskLogs(id, lines),
                    () => { /* best-effort */ },
                );
            }
        }
    }, [cardIds]);

    if (cards.length === 0) {
        return null;
    }

    return (
        <div className={styles["task-widget"]}>
            {cards.map((run) => (
                <TaskCard
                    key={run.id}
                    run={run}
                    lines={taskLogs[run.id]}
                    target={serverLabel(run.target, servers)}
                />
            ))}
        </div>
    );
}

function TaskCard({ run, lines, target }: {
    run: TaskRun;
    lines: TaskLogLine[] | undefined;
    target: string;
}) {
    const tone = statusTone(run.status);
    const done = run.status !== "running" && run.status !== "pending";
    const tail = lines?.slice(-PREVIEW_LINES) ?? [];

    return (
        <div
            className={cx(styles["task-widget-item"], styles[`task-widget-item-${tone}`])}
            onClick={() => taskFeedbackManager.open(run.id)}
        >
            <div className={styles["task-widget-item-head"]}>
                <b className={styles["task-widget-title"]}>{specSummary(run.spec)}</b>
                <button
                    className={shared["btn-icon"]}
                    title="Open the full task view"
                    onClick={(e) => { e.stopPropagation(); taskFeedbackManager.open(run.id); }}
                >
                    ⤢
                </button>
                <button
                    className={shared["btn-icon"]}
                    title="Dismiss"
                    onClick={(e) => { e.stopPropagation(); taskFeedbackManager.dismiss(run.id); }}
                >
                    ✕
                </button>
            </div>
            <div className={styles["task-widget-item-meta"]}>
                <span className={cx(shared.badge, shared[`badge-${tone}`])}>{STATUS_LABEL[run.status]}</span>
                <span className={shared.dim}>{target}</span>
            </div>
            {/* Once a run has landed its result is the headline; the log tail is
                what there is to watch while it hasn't. */}
            {done
                ? <div className={styles["task-widget-result"]}>{resultSummary(run)}</div>
                : <pre className={styles["task-widget-log"]}>{tail.length ? tail.map((l) => l.text).join("\n") : "…"}</pre>}
        </div>
    );
}
