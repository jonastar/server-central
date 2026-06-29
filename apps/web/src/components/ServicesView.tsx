import { useCallback, useEffect, useState } from "react";
import type { ServiceAction, ServiceInfo, SystemdState } from "@central/shared";
import { api } from "../api";
import { cx } from "../utils";
import { EmptyState, ErrorBanner, Modal } from "./ui";
import { LogViewerModal } from "./LogViewerModal";
import { StatusFilter, type StatusToken } from "./StatusFilter";

const REFRESH_MS = 15_000;

/** Maps a unit's active state to a status token used for both the badge and the row accent. */
function activeStatus(active: string): "ok" | "warn" | "err" {
    if (active === "active") {
        return "ok";
    }
    if (active === "failed") {
        return "err";
    }
    return "warn";
}

type Detail = { unit: string; title: string; text: string };

export function ServicesView({ serverId }: { serverId: string }) {
    const [state, setState] = useState<SystemdState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState<StatusToken>("all");
    const [busyUnit, setBusyUnit] = useState<string | null>(null);
    const [detail, setDetail] = useState<Detail | null>(null);
    const [logUnit, setLogUnit] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setState(await api("systemdList", { serverId }));
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

    async function action(svc: ServiceInfo, act: ServiceAction) {
        if ((act === "stop" || act === "disable") && !confirm(`${act} "${svc.unit}"?`)) {
            return;
        }
        setBusyUnit(svc.unit);
        try {
            await api("systemdServiceAction", { serverId, unit: svc.unit, action: act });
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyUnit(null);
        }
    }

    async function showUnitFile(svc: ServiceInfo) {
        try {
            const res = await api("systemdUnitFile", { serverId, unit: svc.unit });
            setDetail({ unit: svc.unit, title: `Unit — ${svc.unit}`, text: res.content || "(empty)" });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    const textFiltered = (state?.services ?? [])
        .filter((s) => !filter || s.unit.toLowerCase().includes(filter.toLowerCase()) || s.description.toLowerCase().includes(filter.toLowerCase()));
    const counts = { all: textFiltered.length, ok: 0, warn: 0, err: 0 };
    for (const s of textFiltered) {
        counts[activeStatus(s.active)]++;
    }
    const shown = textFiltered.filter((s) => statusFilter === "all" || activeStatus(s.active) === statusFilter);

    return (
        <div className="view">
            <header className="view-header">
                <h1>Services</h1>
                <input
                    className="filter-input"
                    placeholder="Filter by unit or description…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
                <StatusFilter
                    value={statusFilter}
                    onChange={setStatusFilter}
                    options={[
                        { value: "all", label: "All", count: counts.all },
                        { value: "ok", label: "Active", count: counts.ok },
                        { value: "warn", label: "Inactive", count: counts.warn },
                        { value: "err", label: "Failed", count: counts.err },
                    ]}
                />
                <button className="btn" onClick={() => void load()}>Refresh</button>
            </header>

            {error && <ErrorBanner>{error}</ErrorBanner>}
            {state === null && !error && <EmptyState>Loading…</EmptyState>}
            {state && !state.available && (
                <EmptyState>Systemd is not available on this server{state.error ? `: ${state.error}` : "."}</EmptyState>
            )}

            {state?.available && (
                <section className="panel">
                    <h3>Services ({shown.length})</h3>
                    {shown.length === 0 ? (
                        <EmptyState>No matching services.</EmptyState>
                    ) : (
                        <table className="data-table">
                            <thead>
                                <tr><th>Unit</th><th>Active</th><th>Sub</th><th>Startup</th><th>Description</th><th /></tr>
                            </thead>
                            <tbody>
                                {shown.map((s) => (
                                    <tr key={s.unit} className={cx(`row-status-${activeStatus(s.active)}`, busyUnit === s.unit && "row-busy")}>
                                        <td><b>{s.unit.replace(/\.service$/, "")}</b></td>
                                        <td><span className={cx("badge", `badge-${activeStatus(s.active)}`)}>{s.active}</span></td>
                                        <td className="dim">{s.sub}</td>
                                        <td className="dim">{s.enabledState ?? "—"}</td>
                                        <td className="dim cmd-cell" title={s.description}>{s.description}</td>
                                        <td className="row-actions-always">
                                            {s.active === "active" ? (
                                                <>
                                                    <button className="btn btn-sm" disabled={busyUnit !== null} onClick={() => void action(s, "restart")}>Restart</button>
                                                    <button className="btn btn-sm" disabled={busyUnit !== null} onClick={() => void action(s, "stop")}>Stop</button>
                                                </>
                                            ) : (
                                                <button className="btn btn-sm" disabled={busyUnit !== null} onClick={() => void action(s, "start")}>Start</button>
                                            )}
                                            {s.enabledState === "enabled" ? (
                                                <button className="btn btn-sm" disabled={busyUnit !== null} onClick={() => void action(s, "disable")}>Disable</button>
                                            ) : s.enabledState === "disabled" ? (
                                                <button className="btn btn-sm" disabled={busyUnit !== null} onClick={() => void action(s, "enable")}>Enable</button>
                                            ) : null}
                                            <button className="btn btn-sm" onClick={() => setLogUnit(s.unit)}>Logs</button>
                                            <button className="btn btn-sm" onClick={() => void showUnitFile(s)}>Unit</button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </section>
            )}

            {detail && (
                <Modal title={detail.title} onClose={() => setDetail(null)} width={820}>
                    <pre className="logs-pre">{detail.text}</pre>
                </Modal>
            )}

            {logUnit && (
                <LogViewerModal
                    title={`Logs — ${logUnit}`}
                    onClose={() => setLogUnit(null)}
                    caps={{ priority: true }}
                    fetchLogs={(q) => api("systemdServiceLogs", { serverId, unit: logUnit, ...q }).then((r) => r.logs)}
                />
            )}
        </div>
    );
}
