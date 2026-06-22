import { useCallback, useEffect, useState } from "react";
import type { DockerImageInfo, DockerState } from "@central/shared";
import { api } from "../../api";
import { cx } from "../../utils";
import { EmptyState, ErrorBanner } from "../ui";

const REFRESH_MS = 15_000;

export function DockerImages({ serverId }: { serverId: string }) {
    const [docker, setDocker] = useState<DockerState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [pullRef, setPullRef] = useState("");
    const [pulling, setPulling] = useState(false);
    const [pullMsg, setPullMsg] = useState<string | null>(null);

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

    async function remove(img: DockerImageInfo) {
        const label = img.repository === "<none>" ? img.id : `${img.repository}:${img.tag}`;
        if (!confirm(`Remove image "${label}"?`)) {
            return;
        }
        setBusy(img.id);
        try {
            await api("dockerImageAction", { serverId, imageId: img.id, action: "remove" });
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    }

    async function pull() {
        const ref = pullRef.trim();
        if (!ref) {
            return;
        }
        setPulling(true);
        setPullMsg(null);
        try {
            const res = await api("dockerImagePull", { serverId, ref });
            setPullMsg(res.message);
            if (res.ok) {
                setPullRef("");
                await load();
            }
        } catch (err) {
            setPullMsg(err instanceof Error ? err.message : String(err));
        } finally {
            setPulling(false);
        }
    }

    return (
        <section className="panel">
            <div className="panel-head">
                <h3>Images ({docker?.images.length ?? 0})</h3>
                <input
                    className="filter-input"
                    placeholder="image:tag to pull…"
                    value={pullRef}
                    disabled={pulling}
                    onChange={(e) => setPullRef(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void pull()}
                />
                <button className="btn" disabled={pulling || !pullRef.trim()} onClick={() => void pull()}>
                    {pulling ? "Pulling…" : "Pull"}
                </button>
            </div>

            {pullMsg && <div className="dim mono" style={{ marginBottom: 8 }}>{pullMsg}</div>}
            {error && <ErrorBanner>{error}</ErrorBanner>}
            {docker === null && !error && <EmptyState>Loading…</EmptyState>}
            {docker && !docker.available && (
                <EmptyState>Docker is not available on this server{docker.error ? `: ${docker.error}` : "."}</EmptyState>
            )}

            {docker?.available && (docker.images.length === 0 ? (
                <EmptyState>No images.</EmptyState>
            ) : (
                <table className="data-table">
                    <thead><tr><th>Repository</th><th>Tag</th><th>Size</th><th>Created</th><th /></tr></thead>
                    <tbody>
                        {docker.images.map((img) => (
                            <tr key={`${img.id}-${img.repository}-${img.tag}`} className={cx(busy === img.id && "row-busy")}>
                                <td>{img.repository}</td>
                                <td className="dim">{img.tag}</td>
                                <td className="dim">{img.size}</td>
                                <td className="dim">{img.createdSince}</td>
                                <td className="row-actions-always">
                                    <button className="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => void remove(img)}>✕</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            ))}
        </section>
    );
}
