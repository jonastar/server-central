import type { MetricsSnapshot, ServerEntry } from "@central/shared";
import { fmtKb, fmtPct, fmtRate, fmtUptime } from "../utils";
import { CoreGrid, TimeSeriesChart, UsageBar } from "./charts";
import { EmptyState, ErrorBanner } from "./ui";

function InfoChip({ label, value }: { label: string; value: string }) {
    return (
        <div className="info-chip">
            <span className="info-chip-label">{label}</span>
            <span className="info-chip-value">{value}</span>
        </div>
    );
}

export function ServerOverview({ entry, history }: {
    entry: ServerEntry;
    history: MetricsSnapshot[];
}) {
    const info = entry.status.info;
    const latest = history.at(-1);
    const uptime = info ? info.uptimeSeconds + (Date.now() - info.capturedAt) / 1000 : null;

    const pts = (pick: (s: MetricsSnapshot) => number) => history.map((s) => ({ ts: s.ts, v: pick(s) }));

    return (
        <div className="view">
            <header className="view-header">
                <h1>{entry.name}</h1>
            </header>

            {entry.status.state === "error" && (
                <ErrorBanner>Connection failed: {entry.status.error}</ErrorBanner>
            )}

            {info && (
                <div className="info-chips">
                    <InfoChip label="Hostname" value={info.hostname} />
                    <InfoChip label="OS" value={info.os} />
                    <InfoChip label="Kernel" value={info.kernel} />
                    <InfoChip label="Arch" value={info.arch} />
                    <InfoChip label="IP" value={info.primaryIp} />
                    <InfoChip label="Uptime" value={uptime ? fmtUptime(uptime) : "—"} />
                    {entry.status.mode && <InfoChip label="Agent" value={entry.status.mode} />}
                    {info.cpuModel && <InfoChip label="CPU" value={`${info.cpuModel} (${info.cpuCores}c)`} />}
                </div>
            )}

            {history.length < 2 ? (
                <EmptyState>
                    {entry.status.state === "online"
                        ? "Collecting first metrics samples…"
                        : "Metrics will appear once the server is connected."}
                </EmptyState>
            ) : (
                <>
                    <div className="panel-grid">
                        <section className="panel">
                            <h3>CPU</h3>
                            <TimeSeriesChart
                                series={[{ label: "total", color: "#3b6ef6", points: pts((s) => s.cpu.total) }]}
                                max={100}
                                fmt={fmtPct}
                            />
                            {latest && <CoreGrid perCore={latest.cpu.perCore} />}
                        </section>
                        <section className="panel">
                            <h3>Memory</h3>
                            <TimeSeriesChart
                                series={[
                                    { label: "used", color: "#7c5cd6", points: pts((s) => s.memory.usedKb) },
                                    ...(latest && latest.memory.swapTotalKb > 0
                                        ? [{ label: "swap", color: "#c987c1", points: pts((s) => s.memory.swapUsedKb) }]
                                        : []),
                                ]}
                                max={latest?.memory.totalKb ?? "auto"}
                                fmt={fmtKb}
                            />
                        </section>
                        <section className="panel">
                            <h3>Network</h3>
                            <TimeSeriesChart
                                series={[
                                    { label: "rx", color: "#22a06b", points: pts((s) => s.network.rxBytesPerSec) },
                                    { label: "tx", color: "#e2a312", points: pts((s) => s.network.txBytesPerSec) },
                                ]}
                                fmt={fmtRate}
                            />
                        </section>
                        <section className="panel">
                            <h3>Disk IO</h3>
                            <TimeSeriesChart
                                series={[
                                    { label: "read", color: "#3b9ef6", points: pts((s) => s.diskIo.readBytesPerSec) },
                                    { label: "write", color: "#d65d45", points: pts((s) => s.diskIo.writeBytesPerSec) },
                                ]}
                                fmt={fmtRate}
                            />
                        </section>
                    </div>

                    {latest && latest.disks.length > 0 && (
                        <section className="panel">
                            <h3>Disk usage</h3>
                            {latest.disks.map((d) => (
                                <UsageBar
                                    key={d.mount}
                                    label={d.mount}
                                    pct={(d.usedKb / d.totalKb) * 100}
                                    detail={`${fmtKb(d.usedKb)} / ${fmtKb(d.totalKb)}`}
                                />
                            ))}
                        </section>
                    )}
                </>
            )}
        </div>
    );
}
