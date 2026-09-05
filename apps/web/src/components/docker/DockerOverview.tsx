import { useCallback, useEffect, useState } from "react";
import type { DockerOverview as Overview } from "@central/shared";
import { api } from "../../api";
import { EmptyState, ErrorBanner } from "../ui";
import { cx } from "../../utils";
import styles from "./DockerOverview.module.css";
import shared from "../../styles/shared.module.css";

const REFRESH_MS = 10_000;

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
    return (
        <div className={styles["stat-card"]}>
            <div className={styles["stat-value"]}>{value}</div>
            <div className={styles["stat-label"]}>{label}</div>
            {sub && <div className={cx(styles["stat-sub"], shared.dim)}>{sub}</div>}
        </div>
    );
}

export function DockerOverview({ serverId }: { serverId: string }) {
    const [data, setData] = useState<Overview | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setData(await api("docker", "overview", { serverId }));
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [serverId]);

    useEffect(() => {
        setData(null);
        void load();
        const timer = setInterval(() => void load(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [load]);

    if (error) {
        return <ErrorBanner>{error}</ErrorBanner>;
    }
    if (data === null) {
        return <EmptyState>Loading…</EmptyState>;
    }
    if (!data.available) {
        return <EmptyState>Docker is not available on this server{data.error ? `: ${data.error}` : "."}</EmptyState>;
    }

    return (
        <>
            <section className={shared.panel}>
                <h3>Overview</h3>
                <div className={styles["stat-grid"]}>
                    <Stat label="Containers" value={`${data.containersRunning}/${data.containersTotal}`} sub="running / total" />
                    <Stat label="Stacks" value={data.stacks} />
                    <Stat label="Volumes" value={data.volumes} />
                    <Stat label="Images" value={data.images} />
                </div>
            </section>

            {data.df && (
                <section className={shared.panel}>
                    <h3>Disk usage</h3>
                    <div className={styles["stat-grid"]}>
                        <Stat label="Images" value={data.df.images} />
                        <Stat label="Containers" value={data.df.containers} />
                        <Stat label="Local Volumes" value={data.df.volumes} />
                        <Stat label="Build Cache" value={data.df.buildCache} />
                    </div>
                </section>
            )}
        </>
    );
}
