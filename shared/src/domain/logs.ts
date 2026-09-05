// ---- Log viewing ---------------------------------------------------------------

/** Display order for log output: oldest line first (classic tail) or newest first. */
export type LogOrder = "oldest" | "newest";
/** Relative time window for log queries. "" means no window (limit only). */
export type LogSince = "" | "15m" | "1h" | "6h" | "24h";
/** Options shared by every log endpoint (docker, journald, …). */
export interface LogQuery {
    /** Max number of lines/entries to return (tail size). */
    limit?: number;
    /** Display order; defaults to "oldest". */
    order?: LogOrder;
    /** Only return entries newer than this window. */
    since?: LogSince;
}

