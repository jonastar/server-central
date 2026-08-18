import { useState } from "react";
import type { ReactNode } from "react";
import type { DockerExecResult, ServerConnState } from "@central/shared";
import { cx, copyToClipboard } from "../utils";
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
