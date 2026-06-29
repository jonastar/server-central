import { useCallback, useEffect, useRef, useState } from "react";
import type { LogOrder, LogSince } from "@central/shared";
import { ErrorBanner, Modal } from "./ui";
import { LogViewer } from "./LogViewer";

/** Full query the controls assemble; `priority`/`timestamps` are source-specific. */
export interface LogQueryFull {
    limit: number;
    order: LogOrder;
    since: LogSince;
    priority?: string;
    timestamps?: boolean;
}

const LIMITS = [200, 500, 1000, 5000];
const SINCE_OPTS: { value: LogSince; label: string }[] = [
    { value: "", label: "Any time" },
    { value: "15m", label: "Last 15m" },
    { value: "1h", label: "Last hour" },
    { value: "6h", label: "Last 6h" },
    { value: "24h", label: "Last 24h" },
];
const PRIORITY_OPTS = [
    { value: "", label: "All levels" },
    { value: "err", label: "Error+" },
    { value: "warning", label: "Warning+" },
    { value: "info", label: "Info+" },
    { value: "debug", label: "Debug+" },
];

/**
 * Log modal that owns the fetch controls (limit, time window, order, and the
 * source-specific severity/timestamps toggles) and refetches whenever they change.
 * The caller supplies `fetchLogs`; the same modal serves docker and journald.
 */
export function LogViewerModal({ title, onClose, fetchLogs, caps }: {
    title: string;
    onClose: () => void;
    fetchLogs: (q: LogQueryFull) => Promise<string>;
    caps?: { priority?: boolean; timestamps?: boolean };
}) {
    const [limit, setLimit] = useState(500);
    const [order, setOrder] = useState<LogOrder>("oldest");
    const [since, setSince] = useState<LogSince>("");
    const [priority, setPriority] = useState("");
    const [timestamps, setTimestamps] = useState(false);
    const [text, setText] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Keep the latest fetcher in a ref so re-renders of the parent (which hands us a
    // fresh closure each time) don't retrigger the refetch effect — only the query does.
    const fetchRef = useRef(fetchLogs);
    fetchRef.current = fetchLogs;

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const out = await fetchRef.current({ limit, order, since, priority: priority || undefined, timestamps });
            setText(out || "(no output)");
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [limit, order, since, priority, timestamps]);

    useEffect(() => { void refresh(); }, [refresh]);

    const controls = (
        <>
            <select className="log-select" value={limit} title="Lines" onChange={(e) => setLimit(Number(e.target.value))}>
                {LIMITS.map((n) => <option key={n} value={n}>{n.toLocaleString()} lines</option>)}
            </select>
            <select className="log-select" value={since} title="Time window" onChange={(e) => setSince(e.target.value as LogSince)}>
                {SINCE_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select className="log-select" value={order} title="Order" onChange={(e) => setOrder(e.target.value as LogOrder)}>
                <option value="oldest">Oldest first</option>
                <option value="newest">Newest first</option>
            </select>
            {caps?.priority && (
                <select className="log-select" value={priority} title="Severity" onChange={(e) => setPriority(e.target.value)}>
                    {PRIORITY_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
            )}
            {caps?.timestamps && (
                <label className="log-toolbar-toggle">
                    <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} /> Timestamps
                </label>
            )}
        </>
    );

    return (
        <Modal title={title} onClose={onClose} large>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            <LogViewer text={text} order={order} loading={loading} onRefresh={() => void refresh()} controls={controls} />
        </Modal>
    );
}
