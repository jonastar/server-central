import { cx } from "../utils";
import styles from "./StatusFilter.module.css";

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
        <div className={styles["status-filter"]}>
            {options.map((o) => (
                <button
                    key={o.value}
                    className={cx(styles["status-pill"], value === o.value && styles.active)}
                    onClick={() => onChange(o.value)}
                >
                    {o.value !== "all" && <span className={cx(styles["pill-dot"], styles[`pill-dot-${o.value}`])} />}
                    {o.label}
                    <span className={styles["status-pill-count"]}>{o.count}</span>
                </button>
            ))}
        </div>
    );
}
