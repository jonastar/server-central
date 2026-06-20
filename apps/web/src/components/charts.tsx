import { useMemo } from "react";
import { cx, fmtPct } from "../utils";

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

/**
 * Sliding time-window line chart. Values are clamped to `max` ("auto" picks a
 * round number from the visible data; percent charts pass 100).
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

    const visible = useMemo(
        () => series.map((s) => ({ ...s, points: s.points.filter((p) => p.ts >= t0) })),
        [series, t0],
    );
    const effMax = max === "auto"
        ? niceMax(visible.reduce((acc, s) => Math.max(acc, ...s.points.map((p) => p.v)), 0))
        : max;

    return (
        <div className="chart">
            <div className="chart-legend">
                {visible.map((s) => (
                    <span key={s.label} className="chart-legend-item">
                        <span className="chart-swatch" style={{ background: s.color }} />
                        {s.label}
                        <b>{s.points.length ? fmt(s.points.at(-1)!.v) : "—"}</b>
                    </span>
                ))}
                <span className="chart-max">max {fmt(effMax)}</span>
            </div>
            <svg viewBox={`0 0 ${VIEW_W} ${height}`} preserveAspectRatio="none" style={{ height }}>
                {[0.25, 0.5, 0.75].map((f) => (
                    <line key={f} x1={0} x2={VIEW_W} y1={height * f} y2={height * f} className="chart-grid" />
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
        </div>
    );
}

export function Sparkline({ points, color = "var(--accent)", height = 28, windowMs = 10 * 60_000, max = 100 }: {
    points: Array<{ ts: number; v: number }>;
    color?: string;
    height?: number;
    windowMs?: number;
    max?: number;
}) {
    const t1 = points.at(-1)?.ts ?? Date.now();
    const t0 = t1 - windowMs;
    const visible = points.filter((p) => p.ts >= t0);
    if (visible.length < 2) {
        return <svg className="sparkline" style={{ height }} />;
    }
    return (
        <svg className="sparkline" viewBox={`0 0 ${VIEW_W} ${height}`} preserveAspectRatio="none" style={{ height }}>
            <path d={toPath(visible, t0, t1, max, height)} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </svg>
    );
}

function loadClass(pct: number): string {
    if (pct >= 90) {
        return "load-high";
    }
    if (pct >= 60) {
        return "load-mid";
    }
    return "load-low";
}

export function UsageBar({ label, pct, detail }: { label: string; pct: number; detail?: string }) {
    return (
        <div className="usage-bar">
            <span className="usage-label" title={label}>{label}</span>
            <div className="usage-track">
                <div className={cx("usage-fill", loadClass(pct))} style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            <span className="usage-detail">{detail ?? fmtPct(pct)}</span>
        </div>
    );
}

/** Per-core CPU load as a row of small vertical bars. */
export function CoreGrid({ perCore }: { perCore: (number | null)[] }) {
    return (
        <div className="core-grid">
            {perCore.map((raw, i) => {
                const pct = raw ?? 0;
                return (
                    <div key={i} className="core-cell" title={`core ${i}: ${fmtPct(pct)}`}>
                        <div className="core-track">
                            <div className={cx("core-fill", loadClass(pct))} style={{ height: `${Math.max(2, Math.min(100, pct))}%` }} />
                        </div>
                        <span className="core-label">{i}</span>
                    </div>
                );
            })}
        </div>
    );
}
