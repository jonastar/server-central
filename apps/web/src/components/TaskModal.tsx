import { useEffect } from "react";
import { api } from "../api";
import { connectionManager } from "../connection";
import { useConnection } from "../hooks/useConnection";
import { useTaskFeedback } from "../hooks/useTaskFeedback";
import { fmtDuration, fmtTime, modalTone, resultSummary, serverLabel, specSummary, STATUS_LABEL, statusTone } from "../taskFormat";
import { taskFeedbackManager } from "../taskFeedback";
import { cx } from "../utils";
import { DetailPair, Modal } from "./ui";
import { LogViewer } from "./LogViewer";
import styles from "./TaskModal.module.css";
import shared from "../styles/shared.module.css";

/**
 * Live detail view for a single task run, opened via `taskFeedbackManager.open(id)`
 * from anywhere (the corner widget's expand control, TasksView, or a call site
 * passing `runTaskAndWait` a `feedback` of `"modal"`, which also closes this
 * again a beat after the run succeeds). Sources from the same WS-driven
 * `useConnection()` state as TasksView, so a running task's status/log stream
 * in live with no polling of its own.
 */
export function TaskModal() {
    const { openTaskId } = useTaskFeedback();
    const { tasks, servers, taskLogs } = useConnection();

    const run = openTaskId ? tasks.find((t) => t.id === openTaskId) ?? null : null;

    useEffect(() => {
        if (!openTaskId || taskLogs[openTaskId] !== undefined) {
            return;
        }
        void api("getTaskLogs", { id: openTaskId }).then(
            (lines) => connectionManager.seedTaskLogs(openTaskId, lines),
            () => { /* best-effort: the log panel just stays empty */ },
        );
    }, [openTaskId, taskLogs]);

    if (!openTaskId || !run) {
        return null;
    }

    const tone = statusTone(run.status);
    const lines = taskLogs[run.id] ?? [];

    return (
        <Modal title={specSummary(run.spec)} onClose={() => taskFeedbackManager.close()} large tone={modalTone(run.status)}>
            <div className={styles["task-modal-meta"]}>
                <DetailPair label="Status">
                    <span className={cx(shared.badge, shared[`badge-${tone}`])}>{STATUS_LABEL[run.status]}</span>
                </DetailPair>
                <DetailPair label="Target">{serverLabel(run.target, servers)}</DetailPair>
                <DetailPair label="Started">{fmtTime(run.startedAt ?? run.createdAt)}</DetailPair>
                <DetailPair label="Duration">{fmtDuration(run)}</DetailPair>
                <DetailPair label="Result">{resultSummary(run)}</DetailPair>
                {run.error && <DetailPair label="Error">{run.error}</DetailPair>}
            </div>
            <div className={styles["task-modal-log"]}>
                <LogViewer text={lines.length ? lines.map((l) => l.text).join("\n") : "(no output yet)"} />
            </div>
        </Modal>
    );
}
