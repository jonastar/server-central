import { useCallback, useEffect, useState } from "react";
import type { MountInfo, MountsState } from "@central/shared";
import { api } from "../api";
import { cx, fmtBytes } from "../utils";
import { EmptyState, ErrorBanner } from "./ui";
import shared from "../styles/shared.module.css";

const REFRESH_MS = 15_000;

function autoMountBadge(m: MountInfo) {
    return (
        <span
            className={cx(shared.badge, shared[m.autoMount.enabled ? "badge-ok" : "badge-warn"])}
            title={m.autoMount.detail}
        >
            {m.autoMount.enabled ? "auto" : "manual"}
        </span>
    );
}

export function MountsView({ serverId }: { serverId: string }) {
    const [state, setState] = useState<MountsState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState("");

    const load = useCallback(async () => {
        try {
            setState(await api("files", "getMounts", { serverId }));
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [serverId]);

    useEffect(() => {
        setState(null);
        void load();
        const timer = setInterval(() => void load(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [load]);

    const shown = (state?.mounts ?? []).filter((m) =>
        !filter || m.mountpoint.toLowerCase().includes(filter.toLowerCase()) || m.device.toLowerCase().includes(filter.toLowerCase()));

    return (
        <div className={shared.view}>
            <header className={shared["view-header"]}>
                <h1>Mounts</h1>
                <button className={shared.btn} onClick={() => void load()}>Refresh</button>
            </header>

            {error && <ErrorBanner>{error}</ErrorBanner>}
            {state === null && !error && <EmptyState>Loading…</EmptyState>}
            {state && !state.available && (
                <EmptyState>Mount info is not available on this server{state.error ? `: ${state.error}` : "."}</EmptyState>
            )}

            {state?.available && (
                <section className={shared.panel}>
                    <div className={shared["panel-head"]}>
                        <h3>Mounts ({shown.length})</h3>
                        <input
                            className={shared["filter-input"]}
                            placeholder="Filter by mountpoint or device…"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                        />
                    </div>
                    {shown.length === 0 ? (
                        <EmptyState>No mounts.</EmptyState>
                    ) : (
                        <table className={shared["data-table"]}>
                            <thead>
                                <tr>
                                    <th>Mountpoint</th>
                                    <th>Device</th>
                                    <th>Type</th>
                                    <th>Size</th>
                                    <th>Used</th>
                                    <th>Available</th>
                                    <th>Auto-mount</th>
                                    <th>Options</th>
                                </tr>
                            </thead>
                            <tbody>
                                {shown.map((m) => (
                                    <tr key={m.mountpoint}>
                                        <td className={shared.mono}>{m.mountpoint}</td>
                                        <td className={cx(shared.mono, shared.dim)}>{m.device}</td>
                                        <td className={shared.dim}>{m.fstype}</td>
                                        <td className={shared.dim}>{fmtBytes(m.sizeBytes)}</td>
                                        <td className={shared.dim}>{fmtBytes(m.usedBytes)}</td>
                                        <td className={shared.dim}>{fmtBytes(m.availBytes)}</td>
                                        <td>{autoMountBadge(m)}</td>
                                        <td className={cx(shared.dim, shared["cmd-cell"])} title={m.options.join(",")}>{m.options.join(", ")}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </section>
            )}
        </div>
    );
}
