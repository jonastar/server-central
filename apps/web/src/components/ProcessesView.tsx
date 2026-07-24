import { useCallback, useEffect, useState } from "react";
import type { ProcessInfo } from "@central/shared";
import { api } from "../api";
import { cx, fmtKb } from "../utils";
import { EmptyState, ErrorBanner } from "./ui";
import shared from "../styles/shared.module.css";

type SortKey = "cpuPct" | "memPct";

export function ProcessesView({ serverId }: { serverId: string }) {
    const [processes, setProcesses] = useState<ProcessInfo[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState("");
    const [sortKey, setSortKey] = useState<SortKey>("cpuPct");

    const load = useCallback(async () => {
        try {
            setProcesses(await api("getProcesses", { serverId }));
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [serverId]);

    useEffect(() => {
        setProcesses(null);
        void load();
        const timer = setInterval(() => void load(), 5000);
        return () => clearInterval(timer);
    }, [load]);

    const shown = (processes ?? [])
        .filter((p) => !filter || p.command.toLowerCase().includes(filter.toLowerCase()) || p.user.includes(filter))
        .sort((a, b) => b[sortKey] - a[sortKey])
        .slice(0, 100);

    return (
        <div className={shared.view}>
            <header className={shared["view-header"]}>
                <h1>Processes</h1>
                <input
                    className={shared["filter-input"]}
                    placeholder="Filter by command or user…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
                <button className={shared.btn} onClick={() => void load()}>Refresh</button>
            </header>

            {error && <ErrorBanner>{error}</ErrorBanner>}
            {processes === null && !error && <EmptyState>Loading…</EmptyState>}

            {processes && (
                <section className={shared.panel}>
                    <table className={shared["data-table"]}>
                        <thead>
                            <tr>
                                <th>PID</th>
                                <th>User</th>
                                <th className={shared["th-sortable"]} onClick={() => setSortKey("cpuPct")}>
                                    CPU%{sortKey === "cpuPct" && " ▾"}
                                </th>
                                <th className={shared["th-sortable"]} onClick={() => setSortKey("memPct")}>
                                    Mem%{sortKey === "memPct" && " ▾"}
                                </th>
                                <th>RSS</th>
                                <th>Started</th>
                                <th>Command</th>
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map((p) => (
                                <tr key={p.pid}>
                                    <td className={shared.dim}>{p.pid}</td>
                                    <td>{p.user}</td>
                                    <td>{p.cpuPct.toFixed(1)}</td>
                                    <td>{p.memPct.toFixed(1)}</td>
                                    <td className={shared.dim}>{fmtKb(p.rssKb)}</td>
                                    <td className={shared.dim}>{p.started}</td>
                                    <td className={cx(shared.mono, shared["cmd-cell"])} title={p.command}>{p.command}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}
        </div>
    );
}
