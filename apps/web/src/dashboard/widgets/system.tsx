import type { MetricsSnapshot } from "@central/shared";
import { useConnection } from "../../hooks/useConnection";
import { fmtKb, fmtPct, fmtRate, fmtUptime } from "../../utils";
import { CoreGrid, TimeSeriesChart, UsageBar } from "../../components/charts";
import { EmptyState } from "../../components/ui";
import { defineWidget, type WidgetProps } from "../types";
import shared from "../../styles/shared.module.css";

// The host's own metrics — the four charts and the disk list the overview page
// used to hard-code, now cards like any other.
//
// Every widget here is tier 1 (doc/idea_host_dashboard.md §2): the data is
// already streaming. `node-server.ts` pushes a `metrics` event per sample and
// ConnectionManager keeps the last 720 snapshots per host, so a live chart is
// `useConnection()` and nothing else — no polling, no new protocol, and the
// chart is live because the store behind it is.

const FEATURE_ID = "servers";

function useHistory(serverId: string): MetricsSnapshot[] {
    return useConnection().metrics[serverId] ?? [];
}

/** Charts need two points to draw a line; this is the shared "not yet" state. */
function Collecting({ online }: { online: boolean }) {
    return (
        <EmptyState>
            {online ? "Collecting first metrics samples…" : "Metrics will appear once the server is connected."}
        </EmptyState>
    );
}

function points(history: MetricsSnapshot[], pick: (s: MetricsSnapshot) => number) {
    return history.map((s) => ({ ts: s.ts, v: pick(s) }));
}

function InfoChip({ label, value }: { label: string; value: string }) {
    return (
        <div className={shared["info-chip"]}>
            <span className={shared["info-chip-label"]}>{label}</span>
            <span className={shared["info-chip-value"]}>{value}</span>
        </div>
    );
}

function HostInfo({ entry }: WidgetProps) {
    const info = entry.status.info;
    if (!info) {
        return <EmptyState>No host info — the agent hasn't identified yet.</EmptyState>;
    }
    const uptime = info.uptimeSeconds + (Date.now() - info.capturedAt) / 1000;
    return (
        <div className={shared["info-chips"]}>
            <InfoChip label="Hostname" value={info.hostname} />
            <InfoChip label="OS" value={info.os} />
            <InfoChip label="Kernel" value={info.kernel} />
            <InfoChip label="Arch" value={info.arch} />
            <InfoChip label="IP" value={info.primaryIp} />
            <InfoChip label="Uptime" value={fmtUptime(uptime)} />
            {entry.status.mode && <InfoChip label="Agent" value={entry.status.mode} />}
            {info.cpuModel && <InfoChip label="CPU" value={`${info.cpuModel} (${info.cpuCores}c)`} />}
        </div>
    );
}

function Cpu({ serverId, entry }: WidgetProps) {
    const history = useHistory(serverId);
    const latest = history.at(-1);
    if (history.length < 2) {
        return <Collecting online={entry.status.state === "online"} />;
    }
    return (
        <>
            <TimeSeriesChart
                series={[{ label: "total", color: "#3b6ef6", points: points(history, (s) => s.cpu.total) }]}
                max={100}
                fmt={fmtPct}
            />
            {latest && <CoreGrid perCore={latest.cpu.perCore} />}
        </>
    );
}

function Memory({ serverId, entry }: WidgetProps) {
    const history = useHistory(serverId);
    const latest = history.at(-1);
    if (history.length < 2) {
        return <Collecting online={entry.status.state === "online"} />;
    }
    return (
        <TimeSeriesChart
            series={[
                { label: "used", color: "#7c5cd6", points: points(history, (s) => s.memory.usedKb) },
                ...(latest && latest.memory.swapTotalKb > 0
                    ? [{ label: "swap", color: "#c987c1", points: points(history, (s) => s.memory.swapUsedKb) }]
                    : []),
            ]}
            max={latest?.memory.totalKb ?? "auto"}
            fmt={fmtKb}
        />
    );
}

function Network({ serverId, entry }: WidgetProps) {
    const history = useHistory(serverId);
    if (history.length < 2) {
        return <Collecting online={entry.status.state === "online"} />;
    }
    return (
        <TimeSeriesChart
            series={[
                { label: "rx", color: "#22a06b", points: points(history, (s) => s.network.rxBytesPerSec) },
                { label: "tx", color: "#e2a312", points: points(history, (s) => s.network.txBytesPerSec) },
            ]}
            fmt={fmtRate}
        />
    );
}

function DiskIo({ serverId, entry }: WidgetProps) {
    const history = useHistory(serverId);
    if (history.length < 2) {
        return <Collecting online={entry.status.state === "online"} />;
    }
    return (
        <TimeSeriesChart
            series={[
                { label: "read", color: "#3b9ef6", points: points(history, (s) => s.diskIo.readBytesPerSec) },
                { label: "write", color: "#d65d45", points: points(history, (s) => s.diskIo.writeBytesPerSec) },
            ]}
            fmt={fmtRate}
        />
    );
}

function DiskUsage({ serverId, entry }: WidgetProps) {
    const latest = useHistory(serverId).at(-1);
    if (!latest || latest.disks.length === 0) {
        return <Collecting online={entry.status.state === "online"} />;
    }
    return (
        <>
            {latest.disks.map((d) => (
                <UsageBar
                    key={d.mount}
                    label={d.mount}
                    pct={(d.usedKb / d.totalKb) * 100}
                    detail={`${fmtKb(d.usedKb)} / ${fmtKb(d.totalKb)}`}
                />
            ))}
        </>
    );
}

export const systemWidgets = [
    defineWidget({
        id: "system.host-info",
        featureId: FEATURE_ID,
        title: "Host",
        description: "Hostname, OS, kernel, address and uptime.",
        defaultSpan: 3,
        inDefaultLayout: 10,
        component: HostInfo,
    }),
    defineWidget({
        id: "system.cpu",
        featureId: FEATURE_ID,
        title: "CPU",
        description: "Total load over time, plus a per-core bar for the latest sample.",
        defaultSpan: 1,
        inDefaultLayout: 20,
        component: Cpu,
    }),
    defineWidget({
        id: "system.memory",
        featureId: FEATURE_ID,
        title: "Memory",
        description: "Used memory over time, with swap when the host has any.",
        defaultSpan: 1,
        inDefaultLayout: 30,
        component: Memory,
    }),
    defineWidget({
        id: "system.network",
        featureId: FEATURE_ID,
        title: "Network",
        description: "Receive and transmit rates over time.",
        defaultSpan: 1,
        inDefaultLayout: 40,
        component: Network,
    }),
    defineWidget({
        id: "system.disk-io",
        featureId: FEATURE_ID,
        title: "Disk IO",
        description: "Read and write throughput over time.",
        defaultSpan: 1,
        inDefaultLayout: 50,
        component: DiskIo,
    }),
    defineWidget({
        id: "system.disk-usage",
        featureId: FEATURE_ID,
        title: "Disk usage",
        description: "Space used per mounted filesystem.",
        defaultSpan: 1,
        inDefaultLayout: 70,
        component: DiskUsage,
    }),
];
