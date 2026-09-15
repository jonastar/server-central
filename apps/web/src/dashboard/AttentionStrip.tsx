import { useState } from "react";
import type { Route } from "../routes";
import { cx } from "../utils";
import { ToneDot } from "../components/ui";
import { worstTone, type HostIssue } from "./issues";
import styles from "./AttentionStrip.module.css";
import shared from "../styles/shared.module.css";

/**
 * The "is anything wrong?" answer at the top of an overview. Serious items
 * (err/warn) are always listed; informational ones hide behind a toggle so
 * a stopped stack or an overdue scrub never dresses up as an incident.
 */
export function AttentionStrip({ issues, waiting, clearText, onNavigate }: {
    issues: Array<HostIssue & { hostName?: string }>;
    /** Still fetching what the list is built from — show a quiet placeholder
     *  rather than a premature "all clear". */
    waiting: boolean;
    clearText: string;
    onNavigate(route: Route): void;
}) {
    const [showAll, setShowAll] = useState(false);
    const serious = issues.filter((i) => i.tone !== "muted");
    const info = issues.filter((i) => i.tone === "muted");
    const tone = worstTone(issues);

    if (issues.length === 0) {
        return (
            <section className={cx(styles.attention, styles["attention-clear"])}>
                <ToneDot tone={waiting ? "muted" : "ok"} />
                {waiting
                    ? <span className={shared.dim}>Checking…</span>
                    : <><strong>All clear.</strong><span className={shared.dim}>{clearText}</span></>}
            </section>
        );
    }

    const shown = showAll ? issues : serious;
    return (
        <section className={cx(styles.attention, styles[`attention-${tone}`])}>
            <div className={styles["attention-head"]}>
                <ToneDot tone={tone} />
                <strong>
                    {serious.length > 0
                        ? `${serious.length} thing${serious.length === 1 ? "" : "s"} need${serious.length === 1 ? "s" : ""} attention`
                        : "Nothing urgent"}
                </strong>
                {info.length > 0 && (
                    <button className={styles["attention-toggle"]} onClick={() => setShowAll((v) => !v)}>
                        {showAll ? "Hide" : "Show"} {info.length} informational
                    </button>
                )}
            </div>
            {shown.length > 0 && (
                <ul className={styles["attention-list"]}>
                    {shown.map((issue, i) => (
                        <li key={i} className={styles["attention-item"]} onClick={() => onNavigate(issue.route)}>
                            <ToneDot tone={issue.tone} />
                            <span className={styles["attention-kind"]}>{issue.kind}</span>
                            <span className={styles["attention-subject"]}>{issue.subject}</span>
                            {issue.detail && <span className={styles["attention-detail"]}>{issue.detail}</span>}
                            {issue.hostName && <span className={styles["attention-host"]}>{issue.hostName}</span>}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
