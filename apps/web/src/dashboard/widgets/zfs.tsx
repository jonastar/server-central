import { fmtBytes, fmtRelative } from "../../utils";
import { UsageBar } from "../../components/charts";
import { EmptyState, ErrorBanner } from "../../components/ui";
import { StatusBadge } from "../../components/docker/status";
import { useHostPoll } from "../useHostPoll";
import { defineWidget, type WidgetProps } from "../types";
import styles from "../HostDashboard.module.css";
import shared from "../../styles/shared.module.css";

// ZFS's card: every pool's health, how full it is, and when it was last
// scrubbed — the three things you'd open the ZFS tab to check and then close
// it again. Tier 2, polled through the shared cache like Docker's.

const FEATURE_ID = "zfs";

function Pools({ serverId, entry }: WidgetProps) {
    const online = entry.status.state === "online";
    const { data, error, loading } = useHostPoll("zfs", "getState", { serverId }, { enabled: online });

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
        return <EmptyState>ZFS is not available on this server{data.error ? `: ${data.error}` : "."}</EmptyState>;
    }
    if (data.pools.length === 0) {
        return <EmptyState>No pools on this host.</EmptyState>;
    }
    return (
        <div className={styles["stack-list"]}>
            {data.pools.map((pool) => {
                const scan = pool.scan;
                const scrub = scan?.state === "in_progress"
                    ? `${scan.kind} ${scan.pctDone !== undefined ? `${Math.round(scan.pctDone)}%` : "running"}`
                    : scan?.kind === "scrub" && scan.state === "completed" && scan.finishedAt
                    ? `scrubbed ${fmtRelative(scan.finishedAt)}`
                    : "never scrubbed";
                return (
                    <div key={pool.name} className={styles["pool-row"]}>
                        <div className={styles["stack-row"]}>
                            <StatusBadge tone={pool.state === "ONLINE" ? "ok" : pool.state === "DEGRADED" ? "warn" : "err"}>{pool.state}</StatusBadge>
                            <span className={styles["stack-name"]}>{pool.name}</span>
                            <span className={shared.dim}>{scrub}</span>
                        </div>
                        <UsageBar label={`${fmtBytes(pool.allocatedBytes)} of ${fmtBytes(pool.sizeBytes)}`} pct={pool.capacityPct} />
                    </div>
                );
            })}
        </div>
    );
}

export const zfsWidgets = [
    defineWidget({
        id: "zfs.pools",
        featureId: FEATURE_ID,
        title: "ZFS pools",
        description: "Health, capacity and last scrub of every pool.",
        requires: "zfs",
        permission: "panel.zfs.read",
        link: { tab: "zfs" },
        defaultSpan: 1,
        inDefaultLayout: 65,
        component: Pools,
    }),
];
