import { useState } from "react";
import { api } from "../../api";
import { useConnection } from "../../hooks/useConnection";
import { specSummary, STATUS_LABEL, statusTone } from "../../taskFormat";
import { taskFeedbackManager, type TaskFeedback } from "../../taskFeedback";
import { cx } from "../../utils";
import { colorVars } from "../../styles/colorVars";
import shared from "../../styles/shared.module.css";
import uiStyles from "../ui.module.css";

/**
 * Development affordances that don't belong to any real feature. Today that's
 * one thing: starting a `debug_fake` run, which does nothing but emit log lines
 * for a few seconds — enough to drive the task widget and the live TaskModal
 * without waiting on a real pull or agent update to reproduce them.
 *
 * Visible to everyone, but `debug_fake` is owner-only server-side, so a
 * non-owner's click comes back as a "requires owner" error rather than a run.
 *
 * `feedback` picks which of the two surfaces the run gets, so both the compact
 * card and the full modal — including how each behaves on success vs failure —
 * can be driven from here without arranging for a real action to fail.
 */
export function DebugTab() {
    const [durationSecs, setDurationSecs] = useState(5);
    const [intervalMs, setIntervalMs] = useState(400);
    const [fail, setFail] = useState(false);
    const [feedback, setFeedback] = useState<TaskFeedback>("progress");
    const [error, setError] = useState<string | null>(null);
    const [starting, setStarting] = useState(false);

    const { tasks } = useConnection();
    const recent = tasks.filter((t) => t.spec.kind === "debug_fake").slice(0, 5);

    async function runFakeTask() {
        setStarting(true);
        setError(null);
        try {
            const { id } = await api("tasks", "run", {
                spec: { kind: "debug_fake", durationMs: durationSecs * 1000, intervalMs, fail },
                target: null,
            });
            if (feedback !== "none") {
                taskFeedbackManager.track(id, feedback);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setStarting(false);
        }
    }

    return (
        <div>
            <div style={{ maxWidth: 480, marginBottom: 28 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>Fake task</h2>
                <p style={{ margin: "0 0 12px", color: colorVars.muted, fontSize: 13 }}>
                    Runs a synthetic task on the control plane that touches nothing — it just
                    streams log lines for the given duration, then succeeds (or fails on
                    request). For exercising the task widget, the live task modal and run
                    history without a real long action to trigger.
                </p>

                <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
                    <label style={{ flex: 1, fontSize: 12, color: colorVars.muted }}>
                        Duration (s)
                        <input
                            type="number"
                            min={0}
                            max={300}
                            value={durationSecs}
                            onChange={(e) => setDurationSecs(Math.max(0, Number(e.target.value)))}
                            style={{ width: "100%", marginTop: 4 }}
                        />
                    </label>
                    <label style={{ flex: 1, fontSize: 12, color: colorVars.muted }}>
                        Line interval (ms)
                        <input
                            type="number"
                            min={50}
                            max={10000}
                            step={50}
                            value={intervalMs}
                            onChange={(e) => setIntervalMs(Math.max(50, Number(e.target.value)))}
                            style={{ width: "100%", marginTop: 4 }}
                        />
                    </label>
                </div>

                <div style={{ display: "flex", gap: 16, marginBottom: 12, fontSize: 13, alignItems: "flex-end" }}>
                    <label style={{ fontSize: 12, color: colorVars.muted }}>
                        Feedback
                        <select
                            value={feedback}
                            onChange={(e) => setFeedback(e.target.value as TaskFeedback)}
                            style={{ display: "block", marginTop: 4 }}
                        >
                            <option value="progress">Progress card</option>
                            <option value="modal">Full modal</option>
                            <option value="none">None</option>
                        </select>
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <input type="checkbox" checked={fail} onChange={(e) => setFail(e.target.checked)} />
                        Fail at the end
                    </label>
                </div>

                <button
                    className={cx(shared.btn, shared["btn-primary"])}
                    type="button"
                    disabled={starting}
                    onClick={() => void runFakeTask()}
                >
                    {starting ? "Starting…" : "Run fake task"}
                </button>

                {error && <div className={uiStyles["error-banner"]} style={{ marginTop: 8 }}>{error}</div>}
            </div>

            {recent.length > 0 && (
                <div style={{ maxWidth: 480 }}>
                    <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 8px" }}>Recent fake runs</h2>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        {recent.map((run) => (
                            <button
                                key={run.id}
                                className={shared.btn}
                                type="button"
                                style={{ display: "flex", justifyContent: "space-between", gap: 12 }}
                                onClick={() => taskFeedbackManager.open(run.id)}
                            >
                                <span>{specSummary(run.spec)}</span>
                                <span className={cx(shared.badge, shared[`badge-${statusTone(run.status)}`])}>
                                    {STATUS_LABEL[run.status]}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
