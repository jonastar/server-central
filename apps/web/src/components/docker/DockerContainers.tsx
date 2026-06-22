import { useCallback, useEffect, useState } from "react";
import type { ContainerAction, ContainerInfo, DockerState } from "@central/shared";
import { api } from "../../api";
import { cx } from "../../utils";
import { EmptyState, ErrorBanner, Modal } from "../ui";
import { LogViewer } from "../LogViewer";
import { ContainerDetail } from "./ContainerDetail";

const REFRESH_MS = 10_000;

function stateBadge(state: string): string {
    if (state === "running") {
        return "badge-ok";
    }
    if (state === "paused" || state === "restarting") {
        return "badge-warn";
    }
    return "badge-err";
}

interface LogState {
    container: ContainerInfo;
    text: string;
    loading: boolean;
}

export function DockerContainers({ serverId, initialFilter }: { serverId: string; initialFilter?: string }) {
    const [docker, setDocker] = useState<DockerState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [filter, setFilter] = useState(initialFilter ?? "");
    const [logs, setLogs] = useState<LogState | null>(null);
    const [detail, setDetail] = useState<ContainerInfo | null>(null);

    const load = useCallback(async () => {
        try {
            setDocker(await api("dockerList", { serverId }));
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [serverId]);

    useEffect(() => {
        setDocker(null);
        void load();
        const timer = setInterval(() => void load(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [load]);

    async function action(container: ContainerInfo, act: ContainerAction) {
        if (act === "remove" && !confirm(`Remove container "${container.name}"?`)) {
            return;
        }
        setBusyId(container.id);
        try {
            await api("dockerContainerAction", { serverId, containerId: container.id, action: act });
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyId(null);
        }
    }

    const fetchLogs = useCallback(async (container: ContainerInfo) => {
        setLogs((prev) => (prev ? { ...prev, loading: true } : { container, text: "", loading: true }));
        try {
            const res = await api("dockerContainerLogs", { serverId, containerId: container.id, tail: 2000 });
            setLogs({ container, text: res.logs || "(no output)", loading: false });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setLogs(null);
        }
    }, [serverId]);

    const shown = (docker?.containers ?? []).filter((c) => {
        if (!filter) {
            return true;
        }
        const q = filter.toLowerCase();
        return c.name.toLowerCase().includes(q)
            || c.image.toLowerCase().includes(q)
            || (c.project ?? "").toLowerCase().includes(q);
    });

    return (
        <section className="panel">
            <div className="panel-head">
                <h3>Containers ({shown.length})</h3>
                <input
                    className="filter-input"
                    placeholder="Filter by name, image or stack…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
            </div>

            {error && <ErrorBanner>{error}</ErrorBanner>}
            {docker === null && !error && <EmptyState>Loading…</EmptyState>}
            {docker && !docker.available && (
                <EmptyState>Docker is not available on this server{docker.error ? `: ${docker.error}` : "."}</EmptyState>
            )}

            {docker?.available && (shown.length === 0 ? (
                <EmptyState>No matching containers.</EmptyState>
            ) : (
                <table className="data-table">
                    <thead>
                        <tr><th>Name</th><th>Stack</th><th>Image</th><th>State</th><th>Status</th><th>Ports</th><th /></tr>
                    </thead>
                    <tbody>
                        {shown.map((c) => (
                            <tr key={c.id} className={cx(busyId === c.id && "row-busy")}>
                                <td>
                                    <button className="link-btn" onClick={() => setDetail(c)}><b>{c.name}</b></button>
                                </td>
                                <td className="dim">{c.project ?? "—"}</td>
                                <td className="dim">{c.image}</td>
                                <td><span className={cx("badge", stateBadge(c.state))}>{c.state}</span></td>
                                <td className="dim">{c.status}</td>
                                <td className="dim mono ports-cell" title={c.ports}>{c.ports}</td>
                                <td className="row-actions-always">
                                    {c.state === "running" ? (
                                        <>
                                            <button className="btn btn-sm" disabled={busyId !== null} onClick={() => void action(c, "stop")}>Stop</button>
                                            <button className="btn btn-sm" disabled={busyId !== null} onClick={() => void action(c, "restart")}>Restart</button>
                                            <button className="btn btn-sm" disabled={busyId !== null} onClick={() => void action(c, "pause")}>Pause</button>
                                        </>
                                    ) : c.state === "paused" ? (
                                        <button className="btn btn-sm" disabled={busyId !== null} onClick={() => void action(c, "unpause")}>Unpause</button>
                                    ) : (
                                        <button className="btn btn-sm" disabled={busyId !== null} onClick={() => void action(c, "start")}>Start</button>
                                    )}
                                    <button className="btn btn-sm" onClick={() => void fetchLogs(c)}>Logs</button>
                                    <button className="btn btn-sm btn-danger" disabled={busyId !== null} onClick={() => void action(c, "remove")}>✕</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ))}

            {logs && (
                <Modal title={`Logs — ${logs.container.name}`} onClose={() => setLogs(null)} width={900}>
                    <LogViewer text={logs.text} loading={logs.loading} onRefresh={() => void fetchLogs(logs.container)} />
                </Modal>
            )}

            {detail && (
                <ContainerDetail
                    serverId={serverId}
                    containerId={detail.id}
                    name={detail.name}
                    onClose={() => setDetail(null)}
                    onShowLogs={() => { void fetchLogs(detail); setDetail(null); }}
                />
            )}
        </section>
    );
}
