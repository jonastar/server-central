import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { DockerExecResult, ServerConnState } from "@central/shared";
import { cx, copyToClipboard, type Tone } from "../utils";
import styles from "./ui.module.css";
import shared from "../styles/shared.module.css";

export function StatusDot({ state, title }: { state: ServerConnState; title?: string }) {
    return <span className={cx(styles["status-dot"], styles[`status-${state}`])} title={title ?? state} />;
}

export function ExperimentalBadge({ compact }: { compact?: boolean }) {
    return (
        <span className={cx(shared.badge, shared["badge-warn"])} title="Experimental feature — still evolving, may change or break">
            {compact ? "EXP" : "Experimental"}
        </span>
    );
}

export function ExperimentalBanner({ children }: { children: ReactNode }) {
    return (
        <div className={styles["warn-banner"]}>
            <strong>Experimental</strong>
            <span>{children}</span>
        </div>
    );
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

/**
 * Right-hand detail panel that sits *beside* a list instead of over it.
 *
 * A modal for row detail meant losing the list behind a scrim, and closing it to
 * look at the next row. The drawer is a plain flex child of {@link DrawerLayout}
 * that sticks to the top of the scroll container, so the list keeps its scroll
 * position and stays clickable — picking another row swaps the drawer's contents
 * rather than closing and reopening a dialog.
 *
 * `header` is the pinned part (breadcrumb, title, actions, tabs); `children` is
 * the scrolling body. Set `fill` for tabs that scroll internally (logs, terminal).
 *
 * `width` is any CSS length — prefer a `clamp()` over a pixel constant, so the
 * drawer takes a real share of a wide display instead of a fixed sliver of it.
 * Below the layout's breakpoint the list steps aside and the drawer takes the
 * whole page; `backLabel` is the way back, and shows only at that size.
 */
export function Drawer({ onClose, header, children, width = "clamp(380px, 30vw, 560px)", fill, backLabel }: {
    onClose: () => void;
    header: ReactNode;
    children: ReactNode;
    width?: number | string;
    fill?: boolean;
    backLabel?: string;
}) {
    const ref = useRef<HTMLElement | null>(null);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // Escape belongs to whatever's focused inside the drawer first — the
            // terminal tab needs it — so only close when focus is elsewhere.
            if (e.key === "Escape" && !ref.current?.contains(document.activeElement)) {
                onClose();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    return (
        <aside ref={ref} className={styles.drawer} style={{ width }} role="complementary">
            <div className={styles["drawer-header"]}>
                {backLabel && (
                    <button type="button" className={cx(shared.btn, shared["btn-sm"], styles["drawer-back"])} onClick={onClose}>
                        {backLabel}
                    </button>
                )}
                {header}
            </div>
            <div className={cx(styles["drawer-body"], fill && styles["drawer-body-fill"])}>{children}</div>
        </aside>
    );
}

/** Wraps a list and its {@link Drawer} — list first, drawer second. */
export function DrawerLayout({ children }: { children: ReactNode }) {
    return <div className={styles["drawer-layout"]}>{children}</div>;
}

/** Colour-only status marker, for where a badge's word won't fit. */
export function ToneDot({ tone, className, title }: { tone: Tone; className?: string; title?: string }) {
    return <span className={cx(styles["tone-dot"], styles[`tone-dot-${tone}`], className)} title={title} />;
}

/**
 * A list whose items are small cards of two lines, rather than table rows of many
 * columns — see `.detailed-list` in the stylesheet for when to reach for it.
 *
 * The slots exist so every list built this way keeps the same rhythm: line one is
 * identity (dot, name, badge, a trailing scrap of dim context), line two is the
 * detail a table would have spent columns on, actions sit right and vertically
 * centred against both lines.
 */
export function DetailedList({ children }: { children: ReactNode }) {
    return <div className={styles["detailed-list"]}>{children}</div>;
}

export function DetailedRow({ tone, title, badge, meta, secondary, actions, selected, busy, onClick }: {
    tone?: Tone;
    title: ReactNode;
    badge?: ReactNode;
    /** Dim trailing context on line one — an uptime, a size, a count. */
    meta?: ReactNode;
    secondary?: ReactNode;
    actions?: ReactNode;
    selected?: boolean;
    busy?: boolean;
    onClick?: () => void;
}) {
    return (
        <div
            className={cx(
                styles["detailed-row"],
                onClick && styles["detailed-row-clickable"],
                selected && styles["detailed-row-selected"],
                busy && styles["detailed-row-busy"],
            )}
            onClick={onClick}
        >
            {tone && <ToneDot tone={tone} className={styles["detailed-row-dot"]} />}
            <div className={styles["detailed-main"]}>
                <div className={styles["detailed-line"]}>
                    <span className={styles["detailed-title"]}>{title}</span>
                    {badge}
                    {meta && <span className={styles["detailed-meta"]}>{meta}</span>}
                </div>
                {secondary && <div className={styles["detailed-secondary"]}>{secondary}</div>}
            </div>
            {/* Actions are their own click target — hitting Restart shouldn't also
                select the row out from under the pointer. */}
            {actions && (
                <div className={styles["detailed-actions"]} onClick={(e) => e.stopPropagation()}>
                    {actions}
                </div>
            )}
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

/** Icon button that copies `text` to the clipboard, with a brief checkmark
 *  confirmation. Standalone, or used by {@link CodeBlock}. */
export function CopyButton({ text, className, title }: { text: string; className?: string; title?: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            className={cx(shared["btn-icon"], styles["copy-btn"], copied && styles.copied, className)}
            title={copied ? "Copied!" : (title ?? "Copy")}
            onClick={() => {
                void copyToClipboard(text).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                });
            }}
        >
            {copied ? "✓" : "⧉"}
        </button>
    );
}

/** Monospaced block (JSON, generated commands, raw text dumps, …) with a copy
 *  button pinned to the corner — the standard way to show copyable text. */
export function CodeBlock({ text, className, style }: { text: string; className?: string; style?: React.CSSProperties }) {
    return (
        <div className={styles["code-block"]} style={style}>
            <CopyButton text={text} className={styles["code-block-copy"]} />
            <pre className={cx(shared["logs-pre"], className)}>{text}</pre>
        </div>
    );
}

/**
 * A "run one command, see the output" box — a thin wrapper around a one-shot
 * `docker exec`/`docker compose exec`, not an attached shell (no cwd/env
 * persistence between runs, no interactivity). `onRun` does the actual call;
 * this owns only the input field and result rendering, so it's reusable for
 * both a container id and a compose service.
 */
export function ExecBox({ onRun, placeholder }: { onRun: (command: string) => Promise<DockerExecResult>; placeholder?: string }) {
    const [command, setCommand] = useState("");
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<DockerExecResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function run() {
        if (!command.trim() || running) {
            return;
        }
        setRunning(true);
        setError(null);
        try {
            setResult(await onRun(command));
        } catch (err) {
            setResult(null);
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setRunning(false);
        }
    }

    const output = result ? [result.stdout, result.stderr].filter(Boolean).join("\n") : "";

    return (
        <div className={styles["exec-box"]}>
            <div className={styles["exec-input-row"]}>
                <input
                    className={shared["filter-input"]}
                    style={{ flex: 1 }}
                    placeholder={placeholder ?? "Run a command…"}
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { void run(); } }}
                    spellCheck={false}
                />
                <button type="button" className={cx(shared.btn, shared["btn-sm"])} disabled={running || !command.trim()} onClick={() => void run()}>
                    {running ? "Running…" : "Run"}
                </button>
            </div>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            {result && (
                <div className={styles["exec-result"]}>
                    <span className={cx(shared.badge, shared[result.code === 0 ? "badge-ok" : "badge-err"])}>exit {result.code}</span>
                    <CodeBlock text={output || "(no output)"} />
                </div>
            )}
        </div>
    );
}

/**
 * "Type the name to confirm" modal for genuinely destructive, hard-to-reverse
 * actions (pool/dataset destroy, snapshot rollback) — a plain `confirm()` is
 * fine for reversible actions (stop a container, disable a unit) but not for
 * ones that can permanently lose data. `children` renders above the input for
 * extra context (e.g. "this destroys 3 newer snapshots").
 */
export interface ActionMenuItem {
    label: string;
    danger?: boolean;
    disabled?: boolean;
    onSelect: () => void;
}

/**
 * Compact "…" button that opens a list of actions — for rows that have more
 * actions than fit as buttons (the stack view's per-service row).
 *
 * The popup is `position: fixed`, placed from the trigger's bounding rect, so it
 * escapes the scroll containers and `overflow` on the panels/tables it opens
 * inside instead of being clipped by them. It closes on outside click, Escape,
 * scroll, or resize — the rect it was placed from goes stale otherwise.
 */
export function ActionMenu({ items, disabled, label = "…", title }: {
    items: ActionMenuItem[];
    disabled?: boolean;
    label?: string;
    title?: string;
}) {
    const btnRef = useRef<HTMLButtonElement | null>(null);
    const [at, setAt] = useState<{ top: number; right: number } | null>(null);

    useEffect(() => {
        if (!at) {
            return;
        }
        const close = () => setAt(null);
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); } };
        // `true` (capture) so a click anywhere closes before the target's own
        // handler runs — including a click on another row's trigger.
        window.addEventListener("mousedown", close, true);
        window.addEventListener("keydown", onKey);
        window.addEventListener("scroll", close, true);
        window.addEventListener("resize", close);
        return () => {
            window.removeEventListener("mousedown", close, true);
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("scroll", close, true);
            window.removeEventListener("resize", close);
        };
    }, [at]);

    function toggle() {
        if (at) {
            setAt(null);
            return;
        }
        const r = btnRef.current?.getBoundingClientRect();
        if (r) {
            setAt({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
        }
    }

    return (
        <>
            <button
                ref={btnRef}
                type="button"
                title={title ?? "Actions"}
                className={cx(shared.btn, shared["btn-sm"])}
                disabled={disabled}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={toggle}
            >
                {label}
            </button>
            {at && (
                <div
                    role="menu"
                    onMouseDown={(e) => e.stopPropagation()}
                    style={{
                        position: "fixed", top: at.top, right: at.right, zIndex: 40, minWidth: 168,
                        background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 6,
                        boxShadow: "0 8px 24px rgba(20,30,60,0.18)", padding: 4,
                        display: "flex", flexDirection: "column",
                    }}
                >
                    {items.map((item) => (
                        <button
                            key={item.label}
                            type="button"
                            role="menuitem"
                            disabled={item.disabled}
                            onClick={() => { setAt(null); item.onSelect(); }}
                            style={{
                                background: "none", border: "none", font: "inherit", textAlign: "left",
                                padding: "6px 10px", borderRadius: 4, cursor: item.disabled ? "default" : "pointer",
                                color: item.disabled ? "var(--muted)" : item.danger ? "var(--err)" : "var(--text)",
                                opacity: item.disabled ? 0.6 : 1,
                            }}
                            onMouseEnter={(e) => { if (!item.disabled) { e.currentTarget.style.background = "var(--panel-2)"; } }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
            )}
        </>
    );
}

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
