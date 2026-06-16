import type { ReactNode } from "react";
import type { ServerConnState } from "@central/shared";
import { cx } from "../utils";

export function StatusDot({ state, title }: { state: ServerConnState; title?: string }) {
    return <span className={cx("status-dot", `status-${state}`)} title={title ?? state} />;
}

export function Modal({ title, onClose, children, width }: {
    title: string;
    onClose: () => void;
    children: ReactNode;
    width?: number;
}) {
    return (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div className="modal" style={width ? { width } : undefined}>
                <div className="modal-header">
                    <h2>{title}</h2>
                    <button className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
                </div>
                <div className="modal-body">{children}</div>
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
