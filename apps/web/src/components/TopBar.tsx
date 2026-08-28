import { useEffect, useState } from "react";
import type { TaskRun } from "@central/shared";
import { useConnection } from "../hooks/useConnection";
import type { Route } from "../routes";
import { fmtAgo, isTerminalStatus, serverLabel, specSummary, STATUS_LABEL, statusTone } from "../taskFormat";
import { taskFeedbackManager } from "../taskFeedback";
import { cx } from "../utils";
import { ToneDot } from "./ui";
import styles from "./TopBar.module.css";
import uiStyles from "./ui.module.css";
import shared from "../styles/shared.module.css";

/** How long a failed run keeps the button flagged. Long enough to catch on the
 *  way back from another tab, short enough that yesterday's failure isn't still
 *  shouting. */
const RECENT_FAILURE_MS = 10 * 60_000;
/** Runs listed in the panel. It's a peek at what's happening, not the history
 *  browser — that's the sidebar's Tasks view, one click away at the bottom. */
const PANEL_RUNS = 12;

/**
 * The app's one global bar, and the home of task state.
 *
 * Tasks used to be announced in the bottom-right and then vanish, which left the
 * sidebar's Tasks view as the only way back to something that had finished. A
 * button that's always here — quiet when idle, spinning while something runs,
 * flagged after a failure — gives the whole system a fixed address, and the
 * transient progress cards ({@link TaskWidget}) stack directly beneath it so
 * both live in one corner instead of two.
 *
 * Sticky rather than fixed: `main` is the scroll container, so this stays put
 * without views having to reserve space for it, and without covering the
 * right-hand controls views put in their own headers.
 */
export function TopBar({ onNavigate }: { onNavigate: (route: Route) => void }) {
    const { tasks } = useConnection();
    const [open, setOpen] = useState(false);

    const running = tasks.filter((t) => !isTerminalStatus(t.status));
    const failed = tasks.filter((t) => t.status === "failed" && Date.now() - (t.finishedAt ?? 0) < RECENT_FAILURE_MS);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open]);

    return (
        <div className={styles["top-bar"]}>
            <div className={styles["top-bar-slot"]}>
                <button
                    className={cx(styles["tasks-button"], open && styles.active)}
                    onClick={() => setOpen((o) => !o)}
                    title="Recent tasks"
                >
                    {running.length > 0
                        ? <><span className={cx(uiStyles.spinner, styles["tasks-spinner"])} />{running.length} running</>
                        : failed.length > 0
                            ? <><ToneDot tone="err" />{failed.length} failed</>
                            : "Tasks"}
                </button>

                {open && (
                    <>
                        {/* Same trick as the modal overlay: one transparent layer
                            underneath means any click elsewhere closes the panel. */}
                        <div className={styles["panel-scrim"]} onMouseDown={() => setOpen(false)} />
                        <div className={styles.panel}>
                            <div className={styles["panel-head"]}>Recent tasks</div>
                            {tasks.length === 0
                                ? <div className={styles["panel-empty"]}>Nothing has run yet.</div>
                                : <div className={styles["panel-list"]}>
                                    {tasks.slice(0, PANEL_RUNS).map((run) => (
                                        <TaskRow key={run.id} run={run} onOpen={() => { taskFeedbackManager.open(run.id); setOpen(false); }} />
                                    ))}
                                </div>}
                            <button
                                className={styles["panel-foot"]}
                                onClick={() => { setOpen(false); onNavigate({ view: "tasks" }); }}
                            >
                                View all tasks
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

function TaskRow({ run, onOpen }: { run: TaskRun; onOpen: () => void }) {
    const { servers } = useConnection();
    const tone = statusTone(run.status);

    return (
        <button className={styles["panel-row"]} onClick={onOpen}>
            <ToneDot tone={tone} title={STATUS_LABEL[run.status]} />
            <span className={styles["panel-row-main"]}>
                <span className={styles["panel-row-title"]}>{specSummary(run.spec)}</span>
                <span className={shared.dim}>{serverLabel(run.target, servers)}</span>
            </span>
            <span className={shared.dim}>{fmtAgo(run.finishedAt ?? run.startedAt ?? run.createdAt)}</span>
        </button>
    );
}
