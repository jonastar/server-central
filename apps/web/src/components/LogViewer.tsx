import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ansiStyleToCss, ansiToSegments, type AnsiSegment } from "../ansi";
import { cx } from "../utils";

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Renders log text with ANSI colors and a find-in-text box (highlight, prev/next,
 * match counter). Fetches nothing itself — the caller supplies the raw text — so it
 * can be reused for container logs, journald output, etc.
 */
export function LogViewer({ text, loading, onRefresh }: {
    text: string;
    loading?: boolean;
    onRefresh?: () => void;
}) {
    const [query, setQuery] = useState("");
    const [wrap, setWrap] = useState(true);
    const [current, setCurrent] = useState(0);
    const bodyRef = useRef<HTMLDivElement>(null);

    const lines = useMemo(() => text.split("\n").map((line) => ansiToSegments(line)), [text]);

    const matcher = useMemo(() => (query ? new RegExp(escapeRegExp(query), "gi") : null), [query]);

    const matchCount = useMemo(() => {
        if (!matcher) {
            return 0;
        }
        const m = text.match(matcher);
        return m ? m.length : 0;
    }, [text, matcher]);

    // Clamp the active match whenever the query/result set changes.
    useEffect(() => {
        setCurrent((c) => (matchCount === 0 ? 0 : Math.min(c, matchCount - 1)));
    }, [matchCount]);

    // Auto-scroll to the bottom on new content while not searching.
    useLayoutEffect(() => {
        if (!query && bodyRef.current) {
            bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
        }
    }, [text, query]);

    // Scroll the active match into view.
    useEffect(() => {
        if (!query) {
            return;
        }
        bodyRef.current?.querySelector(`[data-match="${current}"]`)?.scrollIntoView({ block: "center" });
    }, [current, query, text]);

    function step(delta: number) {
        if (matchCount === 0) {
            return;
        }
        setCurrent((c) => (c + delta + matchCount) % matchCount);
    }

    // Render a single ANSI segment, splitting on search matches. `counter` is a
    // shared mutable cursor so match indices are globally sequential across lines.
    function renderSegment(seg: AnsiSegment, key: number, counter: { n: number }) {
        const css = ansiStyleToCss(seg.style);
        if (!matcher) {
            return <span key={key} style={css}>{seg.text}</span>;
        }
        const parts: React.ReactNode[] = [];
        let last = 0;
        matcher.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = matcher.exec(seg.text)) !== null) {
            if (m.index > last) {
                parts.push(<span key={`${key}-t${last}`} style={css}>{seg.text.slice(last, m.index)}</span>);
            }
            const idx = counter.n++;
            parts.push(
                <mark
                    key={`${key}-m${idx}`}
                    data-match={idx}
                    className={cx("log-match", idx === current && "active")}
                    style={css}
                >
                    {m[0]}
                </mark>,
            );
            last = m.index + m[0].length;
            if (m[0].length === 0) {
                matcher.lastIndex++;
            }
        }
        if (last < seg.text.length) {
            parts.push(<span key={`${key}-t${last}`} style={css}>{seg.text.slice(last)}</span>);
        }
        return <Fragment key={key}>{parts}</Fragment>;
    }

    const counter = { n: 0 };

    return (
        <div className="log-viewer">
            <div className="log-toolbar">
                <input
                    className="filter-input"
                    placeholder="Search logs…"
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); setCurrent(0); }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            step(e.shiftKey ? -1 : 1);
                        }
                    }}
                />
                {query && (
                    <span className="log-match-count">
                        {matchCount === 0 ? "0/0" : `${current + 1}/${matchCount}`}
                    </span>
                )}
                <button className="btn btn-sm" disabled={matchCount === 0} onClick={() => step(-1)}>↑</button>
                <button className="btn btn-sm" disabled={matchCount === 0} onClick={() => step(1)}>↓</button>
                <label className="log-toolbar-toggle">
                    <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap
                </label>
                {onRefresh && (
                    <button className="btn btn-sm" disabled={loading} onClick={onRefresh}>
                        {loading ? "…" : "Refresh"}
                    </button>
                )}
            </div>
            <div ref={bodyRef} className={cx("log-body", wrap ? "wrap" : "nowrap")}>
                {lines.map((segs, i) => (
                    <div key={i} className="log-line">
                        {segs.length === 0
                            ? "​"
                            : segs.map((seg, j) => renderSegment(seg, j, counter))}
                    </div>
                ))}
            </div>
        </div>
    );
}
