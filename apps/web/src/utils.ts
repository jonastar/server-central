import { AGENT_VERSION, type ServerEntry } from "@central/shared";

export function cx(...parts: Array<string | false | null | undefined>): string {
    return parts.filter(Boolean).join(" ");
}

/**
 * An installed, online agent whose reported version trails the control plane's
 * AGENT_VERSION can be updated in place. Live agents are ephemeral (re-run from
 * the latest binary), so they're never flagged.
 */
export function isAgentOutdated(entry: ServerEntry): boolean {
    const { status } = entry;
    return status.state === "online"
        && status.mode === "installed"
        && !!status.info?.agentVersion
        && status.info.agentVersion !== AGENT_VERSION;
}

export function fmtBytes(n: number): string {
    if (!Number.isFinite(n)) {
        return "—";
    }
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let v = n;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtRate(bytesPerSec: number): string {
    return `${fmtBytes(bytesPerSec)}/s`;
}

export function fmtKb(kb: number): string {
    return fmtBytes(kb * 1024);
}

export function fmtPct(n: number): string {
    return `${n.toFixed(n >= 10 ? 0 : 1)}%`;
}

export function fmtUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) {
        return `${d}d ${h}h`;
    }
    if (h > 0) {
        return `${h}h ${m}m`;
    }
    return `${m}m`;
}

export function fmtDateTime(msEpoch: number): string {
    return new Date(msEpoch).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
}
