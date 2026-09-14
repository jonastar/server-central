import { fmtRelative } from "../../utils";
import { fmtDuration, specSummary, statusTone } from "../../taskFormat";
import { EmptyState, ErrorBanner, ToneDot } from "../../components/ui";
import { useHostPoll } from "../useHostPoll";
import { defineWidget, type WidgetProps } from "../types";
import styles from "../HostDashboard.module.css";
import shared from "../../styles/shared.module.css";

// What was last done *to* this host: the task history filtered to it. The
// Tasks view has the fleet's; on a host's own page the question is "did that
// restart I kicked off an hour ago actually finish".

const FEATURE_ID = "tasks";

function RecentTasks({ serverId }: WidgetProps) {
    // Not gated on online: a host's history is control-plane state and reads
    // fine while the box is down — which is when you most want to see it.
    const { data, error, loading } = useHostPoll("tasks", "list", { target: serverId, limit: 8 });

    if (error) {
        return <ErrorBanner>{error}</ErrorBanner>;
    }
    if (loading || !data) {
        return <EmptyState>Loading…</EmptyState>;
    }
    if (data.length === 0) {
        return <EmptyState>No task has run on this host yet.</EmptyState>;
    }
    return (
        <div className={styles["stack-list"]}>
            {data.map((run) => (
                <div key={run.id} className={styles["stack-row"]} title={run.error}>
                    <ToneDot tone={statusTone(run.status)} />
                    <span className={styles["stack-name"]}>{specSummary(run.spec)}</span>
                    <span className={shared.dim}>
                        {run.status === "running"
                            ? "running"
                            : run.finishedAt ? `${fmtRelative(run.finishedAt)} · ${fmtDuration(run)}` : run.status}
                    </span>
                </div>
            ))}
        </div>
    );
}

export const taskWidgets = [
    defineWidget({
        id: "tasks.recent",
        featureId: FEATURE_ID,
        title: "Recent tasks",
        description: "The last runs targeting this host, and how they ended.",
        permission: "panel.tasks.read",
        defaultSpan: 1,
        inDefaultLayout: 80,
        component: RecentTasks,
    }),
];
