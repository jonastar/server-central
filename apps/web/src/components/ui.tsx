import { useState } from "react";
import type { ReactNode } from "react";
import type { ServerConnState } from "@central/shared";
import { cx } from "../utils";
import styles from "./ui.module.css";
import shared from "../styles/shared.module.css";

export function StatusDot({ state, title }: { state: ServerConnState; title?: string }) {
    return <span className={cx(styles["status-dot"], styles[`status-${state}`])} title={title ?? state} />;
}

export function Modal({ title, onClose, children, width, large, tone }: {
    title: string;
    onClose: () => void;
    children: ReactNode;
    width?: number;
    /** Near-fullscreen modal with a flex-fill body — for log viewers and the like. */
    large?: boolean;
    /** Optional header accent — "info" (blue, with a spinner) while something's
     *  in progress, "ok"/"err"/"muted" once it lands. Omit for a plain header. */
    tone?: "info" | "ok" | "err" | "muted";
}) {
    return (
        <div className={styles["modal-overlay"]} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div className={cx(styles.modal, large && styles["modal-large"])} style={!large && width ? { width } : undefined}>
                <div className={cx(styles["modal-header"], tone && styles[`modal-tone-${tone}`])}>
                    <h2>
                        {tone === "info" && <span className={cx(styles.spinner, styles["modal-spinner"])} />}
                        {title}
                    </h2>
                    <button className={shared["btn-icon"]} onClick={onClose} aria-label="Close">✕</button>
                </div>
                <div className={cx(styles["modal-body"], large && styles["modal-body-fill"])}>{children}</div>
            </div>
        </div>
    );
}

export function EmptyState({ children }: { children: ReactNode }) {
    return <div className={styles["empty-state"]}>{children}</div>;
}

/** Aligned label/value pair used in detail modals and expanded table rows. */
export function DetailPair({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className={styles["detail-row"]}>
            <div className={styles["detail-label"]}>{label}</div>
            <div className={styles["detail-value"]}>{children}</div>
        </div>
    );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
    return <div className={styles["error-banner"]}>{children}</div>;
}

/**
 * "Type the name to confirm" modal for genuinely destructive, hard-to-reverse
 * actions (pool/dataset destroy, snapshot rollback) — a plain `confirm()` is
 * fine for reversible actions (stop a container, disable a unit) but not for
 * ones that can permanently lose data. `children` renders above the input for
 * extra context (e.g. "this destroys 3 newer snapshots").
 */
export function ConfirmDangerModal({ title, confirmWord, actionLabel, busy, error, children, onConfirm, onClose }: {
    title: string;
    /** The exact text the operator must type — usually the pool/dataset/snapshot name. */
    confirmWord: string;
    actionLabel: string;
    busy?: boolean;
    error?: string | null;
    children?: ReactNode;
    onConfirm: () => void;
    onClose: () => void;
}) {
    const [typed, setTyped] = useState("");
    const ready = typed === confirmWord;
    return (
        <Modal title={title} onClose={onClose} width={480}>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            {children}
            <label className={shared["login-field"]} style={{ marginTop: 12 }}>
                <span>Type <b className={shared.mono}>{confirmWord}</b> to confirm</span>
                <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} />
            </label>
            <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                <button
                    className={cx(shared.btn, shared["btn-danger"])}
                    type="button"
                    disabled={!ready || busy}
                    onClick={onConfirm}
                >
                    {busy ? "Working…" : actionLabel}
                </button>
            </div>
        </Modal>
    );
}
