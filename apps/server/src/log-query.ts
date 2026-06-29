import type { LogSince } from "@central/shared";

/** journald `--since` phrasing for each relative window token. */
const JOURNAL_SINCE: Record<Exclude<LogSince, "">, string> = {
    "15m": "15 min ago",
    "1h": "1 hour ago",
    "6h": "6 hours ago",
    "24h": "24 hours ago",
};

/** journald `--since` value, or null when no window is requested. */
export function journalSince(since: LogSince | undefined): string | null {
    return since ? JOURNAL_SINCE[since] : null;
}

/** docker `--since` value — Docker accepts Go-duration tokens (e.g. "15m") directly. */
export function dockerSince(since: LogSince | undefined): string | null {
    return since ? since : null;
}

/** journald priority names accepted by `-p` (everything at or above the level). */
const PRIORITIES = new Set(["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"]);

/** Validated journald priority, or null when unset/unrecognised (avoids shell injection). */
export function journalPriority(priority: string | undefined): string | null {
    return priority && PRIORITIES.has(priority) ? priority : null;
}

/**
 * Reverse log output to newest-first. Splits on newlines, so multi-line entries
 * (e.g. stack traces) are reordered line-by-line rather than as whole records.
 */
export function reverseLines(text: string): string {
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
    }
    return lines.reverse().join("\n");
}
