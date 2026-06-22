import { useCallback, useEffect, useState } from "react";
import type { DockerState, DockerVolumeDetail, DockerVolumeInfo } from "@central/shared";
import { api } from "../../api";
import { cx } from "../../utils";
import { EmptyState, ErrorBanner, Modal } from "../ui";

const REFRESH_MS = 15_000;

export function DockerVolumes({ serverId, onBrowse }: { serverId: string; onBrowse: (name: string) => void }) {
    const [docker, setDocker] = useState<DockerState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [detail, setDetail] = useState<DockerVolumeDetail | null>(null);

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

    async function inspect(vol: DockerVolumeInfo) {
        try {
            setDetail(await api("dockerVolumeInspect", { serverId, name: vol.name }));
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    async function remove(vol: DockerVolumeInfo) {
        if (!confirm(`Remove volume "${vol.name}"? This deletes its data.`)) {
            return;
        }
        setBusy(vol.name);
        try {
            await api("dockerVolumeRemove", { serverId, name: vol.name });
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    }

    return (
        <section className="panel">
            <h3>Volumes ({docker?.volumes.length ?? 0})</h3>

            {error && <ErrorBanner>{error}</ErrorBanner>}
            {docker === null && !error && <EmptyState>Loading…</EmptyState>}
            {docker && !docker.available && (
                <EmptyState>Docker is not available on this server{docker.error ? `: ${docker.error}` : "."}</EmptyState>
            )}

            {docker?.available && (docker.volumes.length === 0 ? (
                <EmptyState>No volumes.</EmptyState>
            ) : (
                <table className="data-table">
                    <thead><tr><th>Name</th><th>Driver</th><th>Mountpoint</th><th /></tr></thead>
                    <tbody>
                        {docker.volumes.map((v) => (
                            <tr key={v.name} className={cx(busy === v.name && "row-busy")}>
                                <td><b>{v.name}</b></td>
                                <td className="dim">{v.driver}</td>
                                <td className="dim mono">{v.mountpoint}</td>
                                <td className="row-actions-always">
                                    <button className="btn btn-sm" onClick={() => void inspect(v)}>Inspect</button>
                                    <button className="btn btn-sm" onClick={() => onBrowse(v.name)}>Browse</button>
                                    <button className="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => void remove(v)}>✕</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ))}

            {detail && (
                <Modal title={`Volume — ${detail.name}`} onClose={() => setDetail(null)} width={680}>
                    <div className="detail-grid">
                        <div className="detail-row"><div className="detail-label">Driver</div><div className="detail-value">{detail.driver}</div></div>
                        <div className="detail-row"><div className="detail-label">Mountpoint</div><div className="detail-value mono">{detail.mountpoint}</div></div>
                        {detail.createdAt && <div className="detail-row"><div className="detail-label">Created</div><div className="detail-value">{detail.createdAt}</div></div>}
                        {detail.labels && <div className="detail-row"><div className="detail-label">Labels</div><div className="detail-value mono">{detail.labels}</div></div>}
                        <div className="detail-row">
                            <div className="detail-label">Attached</div>
                            <div className="detail-value">
                                {detail.attached.length === 0 ? "—" : (
                                    <ul className="detail-list">{detail.attached.map((c) => <li key={c.id}>{c.name}</li>)}</ul>
                                )}
                            </div>
                        </div>
                    </div>
                </Modal>
            )}
        </section>
    );
}
