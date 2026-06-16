import { useCallback, useEffect, useState } from "react";
import type { ContainerAction, ContainerInfo, DockerState } from "@central/shared";
import { api } from "../api";
import { cx } from "../utils";
import { EmptyState, ErrorBanner, Modal } from "./ui";

const REFRESH_MS = 10_000;

function stateBadge(state: string): string {
    if (state === "running") return "badge-ok";
    if (state === "paused" || state === "restarting") return "badge-warn";
    return "badge-err";
}

export function DockerView({ serverId }: { serverId: string }) {
    const [docker, setDocker] = useState<DockerState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [logs, setLogs] = useState<{ name: string; text: string } | null>(null);

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
        if (act === "remove" && !confirm(`Remove container "${container.name}"?`)) return;
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

    async function showLogs(container: ContainerInfo) {
        try {
            const res = await api("dockerContainerLogs", { serverId, containerId: container.id, tail: 500 });
            setLogs({ name: container.name, text: res.logs || "(no output)" });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    return (
        <div className="view">
            <header className="view-header">
                <h1>Docker</h1>
                <button className="btn" onClick={() => void load()}>Refresh</button>
            </header>

            {error && <ErrorBanner>{error}</ErrorBanner>}
            {docker === null && !error && <EmptyState>Loading…</EmptyState>}
            {docker && !docker.available && (
                <EmptyState>Docker is not available on this server{docker.error ? `: ${docker.error}` : "."}</EmptyState>
            )}

            {docker?.available && (
                <>
                    <section className="panel">
                        <h3>Containers ({docker.containers.length})</h3>
                        {docker.containers.length === 0 ? (
                            <EmptyState>No containers.</EmptyState>
                        ) : (
                            <table className="data-table">
                                <thead>
                                    <tr><th>Name</th><th>Image</th><th>State</th><th>Status</th><th>Ports</th><th /></tr>
                                </thead>
                                <tbody>
                                    {docker.containers.map((c) => (
                                        <tr key={c.id} className={cx(busyId === c.id && "row-busy")}>
                                            <td><b>{c.name}</b></td>
                                            <td className="dim">{c.image}</td>
                                            <td><span className={cx("badge", stateBadge(c.state))}>{c.state}</span></td>
                                            <td className="dim">{c.status}</td>
                                            <td className="dim mono ports-cell" title={c.ports}>{c.ports}</td>
                                            <td className="row-actions-always">
                                                {c.state === "running" ? (
                                                    <>
                                                        <button className="btn btn-sm" disabled={busyId !== null} onClick={() => void action(c, "stop")}>Stop</button>
                                                        <button className="btn btn-sm" disabled={busyId !== null} onClick={() => void action(c, "restart")}>Restart</button>
                                                    </>
                                                ) : (
                                                    <button className="btn btn-sm" disabled={busyId !== null} onClick={() => void action(c, "start")}>Start</button>
                                                )}
                                                <button className="btn btn-sm" onClick={() => void showLogs(c)}>Logs</button>
                                                <button className="btn btn-sm btn-danger" disabled={busyId !== null} onClick={() => void action(c, "remove")}>✕</button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </section>

                    <div className="panel-grid">
                        <section className="panel">
                            <h3>Volumes ({docker.volumes.length})</h3>
                            <table className="data-table">
                                <thead><tr><th>Name</th><th>Driver</th><th>Mountpoint</th></tr></thead>
                                <tbody>
                                    {docker.volumes.map((v) => (
                                        <tr key={v.name}>
                                            <td>{v.name}</td>
                                            <td className="dim">{v.driver}</td>
                                            <td className="dim mono">{v.mountpoint}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </section>
                        <section className="panel">
                            <h3>Images ({docker.images.length})</h3>
                            <table className="data-table">
                                <thead><tr><th>Repository</th><th>Tag</th><th>Size</th><th>Created</th></tr></thead>
                                <tbody>
                                    {docker.images.map((img) => (
                                        <tr key={`${img.id}-${img.repository}-${img.tag}`}>
                                            <td>{img.repository}</td>
                                            <td className="dim">{img.tag}</td>
                                            <td className="dim">{img.size}</td>
                                            <td className="dim">{img.createdSince}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </section>
                    </div>
                </>
            )}

            {logs && (
                <Modal title={`Logs — ${logs.name}`} onClose={() => setLogs(null)} width={780}>
                    <pre className="logs-pre">{logs.text}</pre>
                </Modal>
            )}
        </div>
    );
}
