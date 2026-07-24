import { useEffect, useState } from "react";
import { api } from "../api";
import { connectionManager } from "../connection";
import { useConnection } from "../hooks/useConnection";
import { serverLabel, specSummary } from "../taskFormat";
import { taskModalManager } from "../taskModal";
import { cx } from "../utils";
import styles from "./TaskWidget.module.css";
import uiStyles from "./ui.module.css";
import shared from "../styles/shared.module.css";

const PREVIEW_LINES = 6;

/**
 * Always-mounted corner widget (App.tsx root) surfacing in-flight task runs
 * app-wide. Collapsed to a small pill; expanding shows each running task with
 * a short log tail, and clicking one opens the full live {@link TaskModal}.
 * Renders nothing once no task is pending/running.
 */
export function TaskWidget() {
    const { tasks, taskLogs, servers } = useConnection();
    const [expanded, setExpanded] = useState(false);

    const running = tasks.filter((t) => t.status === "running" || t.status === "pending");
    const runningIds = running.map((r) => r.id).join(",");

    // Seed logs for any running task the panel is about to show that this
    // client hasn't fetched yet (e.g. a run kicked off before this tab connected).
    useEffect(() => {
        if (!expanded) {
            return;
        }
        for (const run of running) {
            if (taskLogs[run.id] === undefined) {
                void api("getTaskLogs", { id: run.id }).then(
                    (lines) => connectionManager.seedTaskLogs(run.id, lines),
                    () => { /* best-effort */ },
                );
            }
        }
    }, [expanded, runningIds]);

    if (running.length === 0) {
        return null;
    }

    return (
        <div className={styles["task-widget"]}>
            {expanded && (
                <div className={styles["task-widget-panel"]}>
                    {running.map((run) => {
                        const lines = taskLogs[run.id];
                        const tail = lines?.slice(-PREVIEW_LINES) ?? [];
                        return (
                            <div
                                key={run.id}
                                className={styles["task-widget-item"]}
                                onClick={() => {
                                    taskModalManager.open(run.id);
                                    setExpanded(false);
                                }}
                            >
                                <div className={styles["task-widget-item-head"]}>
                                    <b>{specSummary(run.spec)}</b>
                                    <span className={shared.dim}>{serverLabel(run.target, servers)}</span>
                                </div>
                                <pre className={styles["task-widget-log"]}>
                                    {tail.length ? tail.map((l) => l.text).join("\n") : "…"}
                                </pre>
                            </div>
                        );
                    })}
                </div>
            )}
            <button className={styles["task-widget-pill"]} onClick={() => setExpanded((e) => !e)}>
                <span className={cx(uiStyles.spinner, styles["task-widget-spinner"])} />
                {running.length} running
            </button>
        </div>
    );
}
