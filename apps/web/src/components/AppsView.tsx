import { useCallback, useEffect, useState } from "react";
import type { App, AppStatus, ServerEntry } from "@central/shared";
import { api, runTaskAndWait } from "../api";
import { useConnection } from "../hooks/useConnection";
import { cx, fmtRelative } from "../utils";
import { EmptyState, ErrorBanner, ExperimentalBadge, ExperimentalBanner, StatusDot } from "./ui";
import { StatusFilter, type StatusToken } from "./StatusFilter";
import { NewAppModal } from "./NewAppModal";
import { ImportAppModal } from "./ImportAppModal";
import { DeleteAppModal } from "./DeleteAppModal";
import shared from "../styles/shared.module.css";
import styles from "./AppsView.module.css";

const REFRESH_MS = 10_000;

const STATUS_BADGE: Record<AppStatus["status"], "badge-ok" | "badge-warn" | "badge-muted"> = {
    running: "badge-ok",
    partial: "badge-warn",
    stopped: "badge-muted",
    down: "badge-muted",
};

export function AppsView({ servers, onOpenApp }: {
    servers: ServerEntry[];
    onOpenApp: (appId: string) => void;
}) {
    const conn = useConnection();
    const [apps, setApps] = useState<App[] | null>(null);
    const [statuses, setStatuses] = useState<Record<string, AppStatus>>({});
    const [error, setError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [filter, setFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState<StatusToken>("all");
    const [creating, setCreating] = useState<{ hostId?: string } | null>(null);
    const [importing, setImporting] = useState(false);
    const [deleting, setDeleting] = useState<App | null>(null);

    const load = useCallback(async () => {
        try {
            const list = await api("listApps", undefined);
            setApps(list);
            setError(null);
            const entries = await Promise.all(list.map(async (a): Promise<[string, AppStatus | null]> => {
                try {
                    return [a.id, await api("getAppStatus", { appId: a.id })];
                } catch {
                    return [a.id, null];
                }
            }));
            setStatuses(Object.fromEntries(entries.filter((e): e is [string, AppStatus] => e[1] !== null)));
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, []);

    useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [load]);

    async function action(app: App, verb: "restart" | "stop") {
        setBusyId(app.id);
        try {
            await runTaskAndWait({ kind: "docker_compose_action", appId: app.id, action: verb }, app.hostId);
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyId(null);
        }
    }

    function lastAction(app: App): string {
        const runs = conn.tasks.filter((t) =>
            t.spec.kind === "docker_compose_action" && t.spec.appId === app.id
            && t.status !== "pending" && t.status !== "running");
        if (runs.length === 0) {
            return "—";
        }
        const latest = runs.reduce((a, b) => (b.finishedAt ?? b.createdAt) > (a.finishedAt ?? a.createdAt) ? b : a);
        const verb = latest.spec.kind === "docker_compose_action" ? latest.spec.action : "";
        return `${verb} · ${fmtRelative(latest.finishedAt ?? latest.createdAt)}`;
    }

    if (error && !apps) {
        return <ErrorBanner>{error}</ErrorBanner>;
    }
    if (apps === null) {
        return <EmptyState>Loading…</EmptyState>;
    }

    const filtered = apps.filter((a) => a.name.toLowerCase().includes(filter.toLowerCase()));
    const needsAttention = filtered.filter((a) => statuses[a.id]?.status !== "running").length;
    const visible = filtered.filter((a) => statusFilter === "all" || statuses[a.id]?.status !== "running");

    const groups = servers
        .map((server) => ({ server, apps: visible.filter((a) => a.hostId === server.id) }))
        .filter((g) => g.apps.length > 0);

    return (
        <div className={shared.view}>
            <header className={shared["view-header"]}>
                <h1>Apps</h1>
                <ExperimentalBadge />
                {apps.length > 0 && (
                    <StatusFilter
                        value={statusFilter}
                        onChange={setStatusFilter}
                        options={[
                            { value: "all", label: "All", count: filtered.length },
                            { value: "warn", label: "Needs attention", count: needsAttention },
                        ]}
                    />
                )}
                <input
                    className={shared["filter-input"]}
                    placeholder="Filter apps…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    style={{ marginLeft: apps.length > 0 ? undefined : "auto" }}
                />
                <button className={shared.btn} onClick={() => setImporting(true)}>Import existing…</button>
                <button className={cx(shared.btn, shared["btn-primary"])} onClick={() => setCreating({})}>New App</button>
            </header>

            <ExperimentalBanner>
                Apps management is new and still settling — service detection, imports, and status
                reporting can have rough edges. Double-check before relying on it for anything critical.
            </ExperimentalBanner>

            {error && <ErrorBanner>{error}</ErrorBanner>}

            {apps.length === 0 ? (
                <EmptyState>No apps yet.</EmptyState>
            ) : (
                <div className={styles.list}>
                    {groups.length === 0 && <EmptyState>No apps match.</EmptyState>}
                    {groups.map(({ server, apps: hostApps }) => (
                        <section key={server.id} className={styles.group}>
                            <div className={styles["group-header"]}>
                                <StatusDot state={server.status.state} title={server.status.error ?? server.status.state} />
                                <h3 className={styles["group-name"]}>{server.name}</h3>
                                <span className={styles["group-meta"]}>
                                    {server.status.info ? `${server.status.info.primaryIp} · ${server.status.info.os}` : "—"}
                                </span>
                                <span className={styles["group-summary"]}>
                                    {hostApps.length} app{hostApps.length === 1 ? "" : "s"} · {hostApps.filter((a) => statuses[a.id]?.status === "running").length} running
                                </span>
                                <button className={cx(shared.btn, shared["btn-sm"])} onClick={() => setCreating({ hostId: server.id })}>
                                    New App here
                                </button>
                            </div>
                            <div className={styles.grid}>
                                {hostApps.map((app) => {
                                    const status = statuses[app.id];
                                    const services = status?.services ?? [];
                                    const up = services.filter((s) => s.up).length;
                                    return (
                                        <div key={app.id} className={styles.card}>
                                            <div className={styles["card-title-row"]}>
                                                <button className={styles["card-name"]} onClick={() => onOpenApp(app.id)}>{app.name}</button>
                                                <span className={cx(shared.badge, shared[status ? STATUS_BADGE[status.status] : "badge-muted"])}>
                                                    {status ? status.status : "unknown"}
                                                </span>
                                            </div>
                                            <div className={styles["card-meta"]}>
                                                <span className={shared.dim} style={{ fontSize: 12 }}>{up}/{services.length} services up</span>
                                                <span className={styles["card-dir"]} title={app.dir}>{app.dir}</span>
                                            </div>
                                            <div className={styles["bar-row"]}>
                                                <div className={styles.bar}>
                                                    {services.map((s, i) => (
                                                        <span key={i} className={cx(styles["bar-seg"], s.up && styles.up)} />
                                                    ))}
                                                </div>
                                                <span className={styles["bar-last"]}>{lastAction(app)}</span>
                                            </div>
                                            <div className={styles["card-actions"]}>
                                                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busyId === app.id} onClick={() => void action(app, "restart")}>
                                                    Restart
                                                </button>
                                                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busyId === app.id} onClick={() => void action(app, "stop")}>
                                                    Stop
                                                </button>
                                                <button className={cx(shared.btn, shared["btn-sm"])} style={{ marginLeft: "auto" }} onClick={() => onOpenApp(app.id)}>
                                                    Open
                                                </button>
                                                <button className={cx(shared.btn, shared["btn-sm"], shared["btn-danger"])} onClick={() => setDeleting(app)}>
                                                    Remove
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </section>
                    ))}
                </div>
            )}

            {creating && (
                <NewAppModal
                    servers={servers}
                    hostId={creating.hostId}
                    onClose={() => setCreating(null)}
                    onCreated={(appId) => { setCreating(null); onOpenApp(appId); }}
                />
            )}
            {importing && (
                <ImportAppModal
                    servers={servers}
                    onClose={() => setImporting(false)}
                    onImported={(appId) => { setImporting(false); onOpenApp(appId); }}
                />
            )}
            {deleting && (
                <DeleteAppModal
                    app={deleting}
                    host={servers.find((s) => s.id === deleting.hostId)}
                    onClose={() => setDeleting(null)}
                    onDeleted={() => { setDeleting(null); void load(); }}
                />
            )}
        </div>
    );
}
