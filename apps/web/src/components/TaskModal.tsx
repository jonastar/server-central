import { useEffect } from "react";
import { api } from "../api";
import { connectionManager } from "../connection";
import { useConnection } from "../hooks/useConnection";
import { useTaskModal } from "../hooks/useTaskModal";
import { fmtDuration, fmtTime, modalTone, resultSummary, serverLabel, specSummary, STATUS_LABEL, statusTone } from "../taskFormat";
import { taskModalManager } from "../taskModal";
import { cx } from "../utils";
import { DetailPair, Modal } from "./ui";
import { LogViewer } from "./LogViewer";

/**
 * Live detail view for a single task run, opened via `taskModalManager.open(id)`
 * from anywhere (the corner widget, TasksView, or a call site that opts in via
 * `runTaskAndWait`'s `autoOpenModal`). Sources from the same WS-driven
 * `useConnection()` state as TasksView, so a running task's status/log stream
 * in live with no polling of its own.
 */
export function TaskModal() {
    const { openTaskId } = useTaskModal();
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
        <Modal title={specSummary(run.spec)} onClose={() => taskModalManager.close()} large tone={modalTone(run.status)}>
            <div className="task-modal-meta">
                <DetailPair label="Status">
                    <span className={cx("badge", `badge-${tone}`)}>{STATUS_LABEL[run.status]}</span>
                </DetailPair>
                <DetailPair label="Target">{serverLabel(run.target, servers)}</DetailPair>
                <DetailPair label="Started">{fmtTime(run.startedAt ?? run.createdAt)}</DetailPair>
                <DetailPair label="Duration">{fmtDuration(run)}</DetailPair>
                <DetailPair label="Result">{resultSummary(run)}</DetailPair>
                {run.error && <DetailPair label="Error">{run.error}</DetailPair>}
            </div>
            <div className="task-modal-log">
                <LogViewer text={lines.length ? lines.map((l) => l.text).join("\n") : "(no output yet)"} />
            </div>
        </Modal>
    );
}
