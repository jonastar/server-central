import type { ReactNode } from "react";
import type { ServerConnState } from "@central/shared";
import { cx } from "../utils";

export function StatusDot({ state, title }: { state: ServerConnState; title?: string }) {
    return <span className={cx("status-dot", `status-${state}`)} title={title ?? state} />;
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
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div className={cx("modal", large && "modal-large")} style={!large && width ? { width } : undefined}>
                <div className={cx("modal-header", tone && `modal-tone-${tone}`)}>
                    <h2>
                        {tone === "info" && <span className="spinner modal-spinner" />}
                        {title}
                    </h2>
                    <button className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
                </div>
                <div className={cx("modal-body", large && "modal-body-fill")}>{children}</div>
            </div>
        </div>
    );
}

export function EmptyState({ children }: { children: ReactNode }) {
    return <div className="empty-state">{children}</div>;
}

/** Aligned label/value pair used in detail modals and expanded table rows. */
export function DetailPair({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="detail-row">
            <div className="detail-label">{label}</div>
            <div className="detail-value">{children}</div>
        </div>
    );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
    return <div className="error-banner">{children}</div>;
}
