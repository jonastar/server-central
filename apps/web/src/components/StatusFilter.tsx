import { cx } from "../utils";

/** "all" plus the row-status tokens shared with the table accent colors. */
export type StatusToken = "all" | "ok" | "warn" | "err";

export interface StatusOption {
    value: StatusToken;
    label: string;
    count: number;
}

/**
 * Inline segmented filter — every state is visible at once (no dropdown) with its
 * current count, and a colored dot matching the table's status accents. Shared by
 * the Docker containers and systemd services tables.
 */
export function StatusFilter({ value, onChange, options }: {
    value: StatusToken;
    onChange: (v: StatusToken) => void;
    options: StatusOption[];
}) {
    return (
        <div className="status-filter">
            {options.map((o) => (
                <button
                    key={o.value}
                    className={cx("status-pill", value === o.value && "active")}
                    onClick={() => onChange(o.value)}
                >
                    {o.value !== "all" && <span className={cx("pill-dot", `pill-dot-${o.value}`)} />}
                    {o.label}
                    <span className="status-pill-count">{o.count}</span>
                </button>
            ))}
        </div>
    );
}
