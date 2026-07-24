/**
 * Mirrors the CSS custom properties defined in `:root` (global.css), typed so a
 * typo'd variable name is a compile error instead of a silently-ignored `var()`
 * in an inline `style={{}}` prop. Keep in sync with global.css.
 */
export const colorVars = {
    bg: "var(--bg)",
    panel: "var(--panel)",
    panel2: "var(--panel-2)",
    border: "var(--border)",
    text: "var(--text)",
    muted: "var(--muted)",
    accent: "var(--accent)",
    accentSoft: "var(--accent-soft)",
    ok: "var(--ok)",
    warn: "var(--warn)",
    err: "var(--err)",
} as const;
