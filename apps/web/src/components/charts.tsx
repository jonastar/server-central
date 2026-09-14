import { useMemo, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { cx, fmtPct } from "../utils";
import styles from "./charts.module.css";

export interface Series {
    label: string;
    color: string;
    points: Array<{ ts: number; v: number }>;
}

const VIEW_W = 600;

function niceMax(raw: number): number {
    if (raw <= 0) {
        return 1;
    }
    const exp = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 5, 10]) {
        if (raw <= m * exp) {
            return m * exp;
        }
    }
    return 10 * exp;
}

function toPath(points: Array<{ ts: number; v: number }>, t0: number, t1: number, max: number, h: number): string {
    return points
        .map((p, i) => {
            const x = ((p.ts - t0) / (t1 - t0)) * VIEW_W;
            const y = h - Math.min(1, Math.max(0, p.v / max)) * h;
            return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
}

/** Clock time for a tick or tooltip — seconds only when the window is short
 *  enough that a minute label would repeat. */
function fmtClock(ts: number, windowMs: number): string {
    const d = new Date(ts);
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return windowMs <= 5 * 60_000 ? `${hm}:${String(d.getSeconds()).padStart(2, "0")}` : hm;
}

function fmtWindow(windowMs: number): string {
    const min = Math.round(windowMs / 60_000);
    return min < 60 ? `${min} min` : `${Math.round(min / 60)} h`;
}

/**
 * Pointer position over a chart as a timestamp, plus the nearest sample index
 * into `points`. Shared by the chart and the sparkline; the caller decides what
 * to draw with it.
 */
function useHover(t0: number, t1: number) {
    const [ts, setTs] = useState<number | null>(null);
    const onMove = (e: MouseEvent<HTMLElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        setTs(t0 + f * (t1 - t0));
    };
    return { ts, onMove, onLeave: () => setTs(null) };
}

function nearest(points: Array<{ ts: number; v: number }>, ts: number): { ts: number; v: number } | null {
    let best: { ts: number; v: number } | null = null;
    for (const p of points) {
        if (!best || Math.abs(p.ts - ts) < Math.abs(best.ts - ts)) {
            best = p;
        }
    }
    return best;
}

/** The crosshair, the per-series markers and the tooltip, positioned in
 *  percentages over the plot so they survive the SVG's non-uniform scaling. */
function HoverLayer({ at, t0, t1, max, marks, children }: {
    at: number;
    t0: number;
    t1: number;
    max: number;
    marks: Array<{ v: number; color: string }>;
    children: ReactNode;
}) {
    const x = ((at - t0) / (t1 - t0)) * 100;
    // Flip the tooltip to the left of the hairline in the right third, so it
    // never runs off the card.
    const flip = x > 66;
    return (
        <>
            <div className={styles["hover-line"]} style={{ left: `${x}%` }} />
            {marks.map((m, i) => (
                <div key={i} className={styles["hover-dot"]} style={{ left: `${x}%`, top: `${100 - Math.min(1, Math.max(0, m.v / max)) * 100}%`, background: m.color }} />
            ))}
            <div className={cx(styles.tooltip, flip && styles["tooltip-flip"])} style={{ left: `${x}%` }}>
                {children}
            </div>
        </>
    );
}

/**
 * Sliding time-window line chart. Values are clamped to `max` ("auto" picks a
 * round number from the visible data; percent charts pass 100).
 *
 * Hovering shows a crosshair with every series' nearest sample and its clock
 * time; the axis below carries clock ticks so the window's span is legible
 * without reading the legend.
 */
export function TimeSeriesChart({ series, max = "auto", height = 110, windowMs = 15 * 60_000, fmt }: {
    series: Series[];
    max?: number | "auto";
    height?: number;
    windowMs?: number;
    fmt: (v: number) => string;
}) {
    const t1 = series.reduce((acc, s) => Math.max(acc, s.points.at(-1)?.ts ?? 0), 0) || Date.now();
    const t0 = t1 - windowMs;
    const hover = useHover(t0, t1);

    const visible = useMemo(
        () => series.map((s) => ({ ...s, points: s.points.filter((p) => p.ts >= t0) })),
        [series, t0],
    );
    const effMax = max === "auto"
        ? niceMax(visible.reduce((acc, s) => Math.max(acc, ...s.points.map((p) => p.v)), 0))
        : max;

    const hovered = hover.ts === null
        ? null
        : visible.map((s) => ({ ...s, point: nearest(s.points, hover.ts!) })).filter((s) => s.point !== null);
    // Snap the hairline to the actual sample rather than the raw pointer, so it
    // sits on the data — first series' sample decides where.
    const hoverTs = hovered?.[0]?.point?.ts ?? hover.ts;

    return (
        <div className={styles.chart}>
            <div className={styles["chart-legend"]}>
                {visible.map((s) => (
                    <span key={s.label} className={styles["chart-legend-item"]}>
                        <span className={styles["chart-swatch"]} style={{ background: s.color }} />
                        {s.label}
                        <b>{s.points.length ? fmt(s.points.at(-1)!.v) : "—"}</b>
                    </span>
                ))}
                <span className={styles["chart-max"]}>last {fmtWindow(windowMs)} · max {fmt(effMax)}</span>
            </div>
            <div className={styles.plot} onMouseMove={hover.onMove} onMouseLeave={hover.onLeave}>
                <svg viewBox={`0 0 ${VIEW_W} ${height}`} preserveAspectRatio="none" style={{ height }}>
                    {[0.25, 0.5, 0.75].map((f) => (
                        <line key={f} x1={0} x2={VIEW_W} y1={height * f} y2={height * f} className={styles["chart-grid"]} />
                    ))}
                    {[0.25, 0.5, 0.75].map((f) => (
                        <line key={f} x1={VIEW_W * f} x2={VIEW_W * f} y1={0} y2={height} className={styles["chart-grid"]} />
                    ))}
                    {visible.map((s) => s.points.length > 1 && (
                        <g key={s.label}>
                            <path
                                d={`${toPath(s.points, t0, t1, effMax, height)} L${VIEW_W},${height} L${((s.points[0].ts - t0) / (t1 - t0)) * VIEW_W},${height} Z`}
                                fill={s.color}
                                opacity={0.08}
                            />
                            <path d={toPath(s.points, t0, t1, effMax, height)} fill="none" stroke={s.color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                        </g>
                    ))}
                </svg>
                {hovered && hovered.length > 0 && hoverTs !== null && (
                    <HoverLayer at={hoverTs} t0={t0} t1={t1} max={effMax} marks={hovered.map((s) => ({ v: s.point!.v, color: s.color }))}>
                        <div className={styles["tooltip-time"]}>{fmtClock(hoverTs, windowMs)}</div>
                        {hovered.map((s) => (
                            <div key={s.label} className={styles["tooltip-row"]}>
                                <span className={styles["chart-swatch"]} style={{ background: s.color }} />
                                <span>{s.label}</span>
                                <b>{fmt(s.point!.v)}</b>
                            </div>
                        ))}
                    </HoverLayer>
                )}
            </div>
            <div className={styles.axis}>
                {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                    <span key={f} className={styles.tick} style={{ left: `${f * 100}%` }}>
                        {f === 1 ? "now" : fmtClock(t0 + f * windowMs, windowMs)}
                    </span>
                ))}
            </div>
        </div>
    );
}

/**
 * Inline single-series line, for a card row. Passing `fmt` turns on hover
 * (hairline + value and time) and a small window label in the corner, so the
 * period is stated rather than implied.
 */
export function Sparkline({ points, color = "var(--accent)", height = 28, windowMs = 10 * 60_000, max = 100, className, fmt }: {
    points: Array<{ ts: number; v: number }>;
    color?: string;
    height?: number;
    windowMs?: number;
    max?: number;
    className?: string;
    fmt?: (v: number) => string;
}) {
    const t1 = points.at(-1)?.ts ?? Date.now();
    const t0 = t1 - windowMs;
    const hover = useHover(t0, t1);
    const visible = points.filter((p) => p.ts >= t0);
    if (visible.length < 2) {
        return <svg className={cx(styles.sparkline, className)} style={{ height }} />;
    }
    const svg = (
        <svg className={cx(styles.sparkline, !fmt && className)} viewBox={`0 0 ${VIEW_W} ${height}`} preserveAspectRatio="none" style={{ height }}>
            <path d={toPath(visible, t0, t1, max, height)} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </svg>
    );
    if (!fmt) {
        return svg;
    }
    const point = hover.ts === null ? null : nearest(visible, hover.ts);
    return (
        <div className={cx(styles["spark-wrap"], className)} style={{ height }} onMouseMove={hover.onMove} onMouseLeave={hover.onLeave}>
            {svg}
            {point === null && <span className={styles["spark-window"]}>{fmtWindow(windowMs)}</span>}
            {point && (
                <HoverLayer at={point.ts} t0={t0} t1={t1} max={max} marks={[{ v: point.v, color }]}>
                    <div className={styles["tooltip-row"]}>
                        <span>{fmtClock(point.ts, windowMs)}</span>
                        <b>{fmt(point.v)}</b>
                    </div>
                </HoverLayer>
            )}
        </div>
    );
}

function loadClass(pct: number): string {
    if (pct >= 90) {
        return styles["load-high"];
    }
    if (pct >= 60) {
        return styles["load-mid"];
    }
    return styles["load-low"];
}

export function UsageBar({ label, pct, detail }: { label: string; pct: number; detail?: string }) {
    return (
        <div className={styles["usage-bar"]}>
            <span className={styles["usage-label"]} title={label}>{label}</span>
            <div className={styles["usage-track"]}>
                <div className={cx(styles["usage-fill"], loadClass(pct))} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            <span className={styles["usage-detail"]}>{detail ?? fmtPct(pct)}</span>
        </div>
    );
}

/** Per-core CPU load as a row of small vertical bars. */
export function CoreGrid({ perCore }: { perCore: (number | null)[] }) {
    return (
        <div className={styles["core-grid"]}>
            {perCore.map((raw, i) => {
                const pct = raw ?? 0;
                return (
                    <div key={i} className={styles["core-cell"]} title={`core ${i}: ${fmtPct(pct)}`}>
                        <div className={styles["core-track"]}>
                            <div className={cx(styles["core-fill"], loadClass(pct))} style={{ height: `${Math.max(2, Math.min(100, pct))}%` }} />
                        </div>
                        <span className={styles["core-label"]}>{i}</span>
                    </div>
                );
            })}
        </div>
    );
}
