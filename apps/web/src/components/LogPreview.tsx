import { useCallback, useEffect, useRef, useState } from "react";
import type { LogQueryFull } from "./LogViewerModal";

const PREVIEW_LINES = 12;

/**
 * Compact inline tail of the most recent log lines, shown inside an expanded
 * table row. Fetches the last few lines in chronological order (terminal-style,
 * latest at the bottom) and offers a refresh plus a jump to the full log viewer.
 */
export function LogPreview({ fetchLogs, onOpenFull }: {
    fetchLogs: (q: LogQueryFull) => Promise<string>;
    onOpenFull?: () => void;
}) {
    const [text, setText] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const bodyRef = useRef<HTMLPreElement>(null);

    // The parent hands us a fresh closure each render; keep the latest in a ref so
    // the fetch effect only runs on mount / explicit refresh, not on every re-render.
    const fetchRef = useRef(fetchLogs);
    fetchRef.current = fetchLogs;

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const out = await fetchRef.current({ limit: PREVIEW_LINES, order: "oldest", since: "" });
            setText(out.trimEnd() || "(no recent output)");
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    // Keep the newest line (bottom) in view whenever fresh output arrives.
    useEffect(() => {
        const el = bodyRef.current;
        if (el && !error) {
            el.scrollTop = el.scrollHeight;
        }
    }, [text, error]);

    return (
        <div className="log-preview">
            <div className="log-preview-head">
                <span className="detail-label">Recent logs</span>
                <button className="btn btn-sm" onClick={() => void load()} disabled={loading} title="Refresh">
                    {loading ? "…" : "↻"}
                </button>
                {onOpenFull && <button className="btn btn-sm" onClick={onOpenFull}>Open full logs</button>}
            </div>
            <pre ref={bodyRef} className={"log-preview-body" + (error ? " dim" : "")}>
                {error ?? text ?? "Loading…"}
            </pre>
        </div>
    );
}
