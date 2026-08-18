/**
 * Tracks when the currently-mounted `TerminalView` connected, so the leave
 * confirmation (in-app navigation guard in `App.tsx`, `beforeunload` in
 * `TerminalView.tsx`) can skip the prompt for the first few seconds — closing
 * a terminal you just barely opened (e.g. a fast double-click through nav
 * tabs) shouldn't nag, only a session you've actually been sitting in.
 */
const GRACE_MS = 5000;

let openedAt: number | null = null;

export function markTerminalOpened(): void {
    openedAt = Date.now();
}

export function markTerminalClosed(): void {
    openedAt = null;
}

/** True once a terminal is open and has been for at least {@link GRACE_MS}. */
export function terminalNeedsLeaveConfirm(): boolean {
    return openedAt !== null && Date.now() - openedAt >= GRACE_MS;
}
