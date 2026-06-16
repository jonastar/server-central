import type { MetricsSnapshot, ServerEntry } from "@central/shared";
import { fmtKb, fmtPct, fmtRate, fmtUptime } from "../utils";
import { Sparkline, UsageBar } from "./charts";
import { StatusDot, EmptyState } from "./ui";

export function Dashboard({ servers, metrics, onOpenServer }: {
    servers: ServerEntry[];
    metrics: Record<string, MetricsSnapshot[]>;
    onOpenServer: (serverId: string) => void;
}) {
    return (
        <div className="view">
            <header className="view-header">
                <h1>Dashboard</h1>
            </header>

            {servers.length === 0 && (
                <EmptyState>
                    No agents connected yet.
                </EmptyState>
            )}

            <div className="card-grid">
                {servers.map((entry) => {
                    const history = metrics[entry.id] ?? [];
                    const latest = history.at(-1);
                    const info = entry.status.info;
                    const uptime = info ? info.uptimeSeconds + (Date.now() - info.capturedAt) / 1000 : null;
                    const worstDisk = latest?.disks.reduce<typeof latest.disks[number] | null>(
                        (acc, d) => (!acc || d.usedKb / d.totalKb > acc.usedKb / acc.totalKb ? d : acc),
                        null,
                    );
                    return (
                        <div key={entry.id} className="server-card" onClick={() => onOpenServer(entry.id)}>
                            <div className="card-head">
                                <StatusDot state={entry.status.state} title={entry.status.error ?? entry.status.state} />
                                <span className="card-title">{entry.name}</span>
                                <span className="card-host">{info?.primaryIp ?? ""}</span>
                            </div>
                            <div className="card-sub">
                                {info ? `${info.os} · up ${fmtUptime(uptime!)}` : entry.status.error ?? entry.status.state}
                            </div>
                            {latest ? (
                                <>
                                    <div className="card-row">
                                        <span className="card-label">CPU</span>
                                        <Sparkline points={history.map((s) => ({ ts: s.ts, v: s.cpu.total }))} />
                                        <b>{fmtPct(latest.cpu.total)}</b>
                                    </div>
                                    <UsageBar
                                        label="Mem"
                                        pct={(latest.memory.usedKb / latest.memory.totalKb) * 100}
                                        detail={`${fmtKb(latest.memory.usedKb)} / ${fmtKb(latest.memory.totalKb)}`}
                                    />
                                    {worstDisk && (
                                        <UsageBar
                                            label={worstDisk.mount}
                                            pct={(worstDisk.usedKb / worstDisk.totalKb) * 100}
                                            detail={`${fmtKb(worstDisk.usedKb)} / ${fmtKb(worstDisk.totalKb)}`}
                                        />
                                    )}
                                    <div className="card-row card-net">
                                        <span className="card-label">Net</span>
                                        <span>↓ {fmtRate(latest.network.rxBytesPerSec)}</span>
                                        <span>↑ {fmtRate(latest.network.txBytesPerSec)}</span>
                                    </div>
                                </>
                            ) : (
                                <div className="card-pending">
                                    {entry.status.state === "online" ? "Collecting metrics…" : "No metrics — server not connected"}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
