import type { ReactNode } from "react";
import type { ServerConnState } from "@central/shared";
import { cx } from "../utils";

export function StatusDot({ state, title }: { state: ServerConnState; title?: string }) {
    return <span className={cx("status-dot", `status-${state}`)} title={title ?? state} />;
}

export function Modal({ title, onClose, children, width, large }: {
    title: string;
    onClose: () => void;
    children: ReactNode;
    width?: number;
    /** Near-fullscreen modal with a flex-fill body — for log viewers and the like. */
    large?: boolean;
}) {
    return (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div className={cx("modal", large && "modal-large")} style={!large && width ? { width } : undefined}>
                <div className="modal-header">
                    <h2>{title}</h2>
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

export function ErrorBanner({ children }: { children: ReactNode }) {
    return <div className="error-banner">{children}</div>;
}
