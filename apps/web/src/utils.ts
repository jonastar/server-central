import { AGENT_VERSION, type HostCapability, type HostCapabilityResult, type ServerEntry, type ServerStatus } from "@central/shared";

export function cx(...parts: Array<string | false | null | undefined>): string {
    return parts.filter(Boolean).join(" ");
}

/**
 * The four status colours the UI speaks, shared by badges, table row accents and
 * detailed-list dots: `ok` healthy, `warn` in between, `err` broken, `muted`
 * nothing there. Lives here rather than in a feature module so the generic
 * components in `ui.tsx` can take one without importing a feature.
 */
export type Tone = "ok" | "warn" | "err" | "muted";

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

/**
 * A host capability's state, as three cases the UI must keep distinct:
 * `undefined` (unknown — never probed, agent too old, or host offline),
 * `{ available: true }`, and `{ available: false, detail }`.
 *
 * Unknown deliberately reads as "not unavailable" at every call site below:
 * greying a tab because a host is momentarily offline would make the whole
 * sidebar flicker on each reconnect, and would hide features on older agents
 * that support them perfectly well.
 */
export function hostCapability(status: ServerStatus | undefined, capability: HostCapability): HostCapabilityResult | undefined {
    return status?.hostCapabilities?.[capability];
}

/** True only when a host has *positively reported* the capability missing. */
export function hostCapabilityUnavailable(status: ServerStatus | undefined, capability: HostCapability | undefined): boolean {
    return capability !== undefined && hostCapability(status, capability)?.available === false;
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

/** Base64-encode raw bytes, chunked to avoid blowing the call stack on large files. */
/** Decode base64 bytes the agent sent inline — currently image previews, which
 *  are size-capped and arrive inside the JSON `FileContent`. There is deliberately
 *  no encoding counterpart: an upload streams its `File` through multipart
 *  instead, so nothing in the browser turns a file into base64 any more. */
export function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * The async Clipboard API is only exposed in secure contexts (HTTPS or
 * localhost), so `navigator.clipboard` is undefined when the control plane is
 * reached over plain HTTP. Fall back to the old execCommand trick there.
 */
export async function copyToClipboard(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
        if (!document.execCommand("copy")) {
            throw new Error("Copy command failed");
        }
    } finally {
        document.body.removeChild(textarea);
    }
}

/**
 * A random UUID, without requiring a secure context.
 *
 * `crypto.randomUUID` is only exposed over HTTPS or on localhost — the same
 * restriction that {@link copyToClipboard} works around — so it is simply
 * missing when the control plane is reached over plain HTTP at a LAN address,
 * which is a normal way to run this. `crypto.getRandomValues` has no such
 * restriction and is always there, so the fallback is a real v4 UUID rather
 * than a weaker id.
 *
 * Reach for this instead of `crypto.randomUUID` anywhere in the web app.
 */
export function randomId(): string {
    if (typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function fmtDateTime(msEpoch: number): string {
    return new Date(msEpoch).toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
}

/** Compact relative time ("3h ago", "2d ago") for card/row timestamps. Falls
 *  back to a full date past a week, where "Nd ago" stops being legible. */
export function fmtRelative(msEpoch: number): string {
    const secs = Math.max(0, Math.round((Date.now() - msEpoch) / 1000));
    if (secs < 60) {
        return "just now";
    }
    if (secs < 3600) {
        return `${Math.floor(secs / 60)}m ago`;
    }
    if (secs < 86400) {
        return `${Math.floor(secs / 3600)}h ago`;
    }
    if (secs < 7 * 86400) {
        return `${Math.floor(secs / 86400)}d ago`;
    }
    return fmtDateTime(msEpoch);
}
