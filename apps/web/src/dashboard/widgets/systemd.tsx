import { EmptyState, ErrorBanner } from "../../components/ui";
import { StatusBadge } from "../../components/docker/status";
import { useHostPoll } from "../useHostPoll";
import { defineWidget, type WidgetProps } from "../types";
import styles from "../HostDashboard.module.css";
import shared from "../../styles/shared.module.css";

// A third feature's widget, mostly to keep the registry honest: nothing about
// the dashboard is Docker-specific, and a feature contributes a card by
// exporting an array, not by touching the overview page.

function FailedUnits({ serverId, entry }: WidgetProps) {
    const online = entry.status.state === "online";
    const { data, error, loading } = useHostPoll("systemdList", { serverId }, { enabled: online });

    if (!online) {
        return <EmptyState>Server is not connected.</EmptyState>;
    }
    if (error) {
        return <ErrorBanner>{error}</ErrorBanner>;
    }
    if (loading || !data) {
        return <EmptyState>Loading…</EmptyState>;
    }
    if (!data.available) {
        return <EmptyState>systemd is not available on this server{data.error ? `: ${data.error}` : "."}</EmptyState>;
    }
    const failed = data.services.filter((s) => s.active === "failed" || s.sub === "failed");
    if (failed.length === 0) {
        return <EmptyState>No failed units.</EmptyState>;
    }
    return (
        <div className={styles["stack-list"]}>
            {failed.map((svc) => (
                <div key={svc.unit} className={styles["stack-row"]}>
                    <StatusBadge tone="err">{svc.active}</StatusBadge>
                    <span className={styles["stack-name"]} title={svc.description}>{svc.unit}</span>
                    <span className={shared.dim}>{svc.sub}</span>
                </div>
            ))}
        </div>
    );
}

export const systemdWidgets = [
    defineWidget({
        id: "systemd.failed-units",
        featureId: "systemd",
        title: "Failed units",
        description: "systemd units currently in a failed state.",
        requires: "systemd",
        defaultSpan: 1,
        component: FailedUnits,
    }),
];
