import { useCallback, useEffect, useState } from "react";
import type { DeviceAuthorizationRequest } from "@central/shared";
import { api } from "../../api";
import { useAuth } from "../../hooks/useAuth";
import { LoginView } from "../LoginView";
import { BrandLockup } from "../Brand";
import { EmptyState, ErrorBanner } from "../ui";
import shared from "../../styles/shared.module.css";
import { colorVars } from "../../styles/colorVars";

/**
 * `/device` — the browser half of the device grant (RFC 8628 §3.3).
 *
 * A television displays a code and polls; this is where a human types it in on
 * something with a keyboard. Mounted directly by main.tsx rather than through
 * the hash router, for the same reason `/oidc/authorize` is: the URL is read off
 * a screen and typed by hand, and `https://sc.example.com/device` is a thing a
 * person can retype where `…/#/device` is not. It is also the `verification_uri`
 * the device is told to display, so the path is part of the protocol.
 */
export function DeviceApproveView() {
    const auth = useAuth();
    // Arriving from the QR code on the television carries the code already, so
    // that path skips typing entirely; arriving by reading the URL aloud does
    // not, and gets the entry field.
    const [typed, setTyped] = useState(() => new URLSearchParams(window.location.search).get("user_code") ?? "");
    const [request, setRequest] = useState<DeviceAuthorizationRequest | null>(null);
    const [outcome, setOutcome] = useState<"approved" | "denied" | null>(null);
    const [notFound, setNotFound] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const lookup = useCallback(async (code: string) => {
        setBusy(true);
        setError(null);
        setNotFound(false);
        try {
            const found = await api("oidc", "getDeviceRequest", { userCode: code });
            setRequest(found);
            setNotFound(found === null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }, []);

    // Only for the QR-code path: a code that arrived in the URL is resolved
    // without waiting for a submit nobody meant to make.
    const prefilled = typed !== "";
    useEffect(() => {
        if (auth.user && prefilled) {
            void lookup(typed);
        }
        // Deliberately once, on the code the page was opened with. Re-running
        // this on every keystroke would look up half-typed codes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [auth.user]);

    async function answer(decision: "approved" | "denied") {
        setBusy(true);
        setError(null);
        try {
            await api("oidc", decision === "approved" ? "approveDevice" : "denyDevice", { userCode: typed });
            setOutcome(decision);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    if (auth.loading) {
        return <EmptyState>Loading…</EmptyState>;
    }
    // Approving authorizes the device as *you*, so who "you" are has to be
    // settled first — the same login screen the rest of the app uses.
    if (auth.needsSetup) {
        return <LoginView mode="setup" onSubmit={auth.setup} />;
    }
    if (!auth.user) {
        return <LoginView mode="login" onSubmit={auth.login} />;
    }

    return (
        <div className={shared["login-screen"]}>
            <div className={shared["login-card"]}>
                <h1 className={shared["login-title"]}><BrandLockup height={26} /></h1>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                {outcome === "approved" && (
                    <>
                        <p className={shared["login-subtitle"]}>Device connected.</p>
                        <p style={{ fontSize: 12, color: colorVars.muted, marginTop: -8 }}>
                            It should sign itself in within a few seconds. You can close this page.
                        </p>
                    </>
                )}
                {outcome === "denied" && (
                    <p className={shared["login-subtitle"]}>Request refused. The device was not connected.</p>
                )}
                {outcome === null && (request
                    ? <Confirm request={request} username={auth.user.username} busy={busy} onAnswer={answer} />
                    : <CodeEntry typed={typed} notFound={notFound} busy={busy} onChange={(v) => { setTyped(v); setNotFound(false); }} onSubmit={() => void lookup(typed)} />)}
            </div>
        </div>
    );
}

function CodeEntry({ typed, notFound, busy, onChange, onSubmit }: {
    typed: string;
    notFound: boolean;
    busy: boolean;
    onChange(value: string): void;
    onSubmit(): void;
}) {
    return (
        <form
            style={{ display: "flex", flexDirection: "column", gap: 14 }}
            onSubmit={(e) => { e.preventDefault(); onSubmit(); }}
        >
            <p className={shared["login-subtitle"]}>Enter the code shown on your device.</p>
            <label className={shared["login-field"]}>
                <span>Device code</span>
                <input
                    autoFocus
                    value={typed}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder="XXXX-XXXX"
                    // Uppercase and wide-spaced because that is how it appears
                    // on the television being copied from. The server accepts
                    // any casing and ignores the dash, so this is presentation.
                    style={{ textTransform: "uppercase", letterSpacing: "0.18em", fontFamily: "var(--mono, monospace)" }}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                />
            </label>
            {notFound && (
                // Expired, already answered and mistyped are one message,
                // because the server does not distinguish them and because the
                // action is the same in all three cases.
                <ErrorBanner>That code isn&apos;t valid. Check the code on your device — it may have expired, in which case start again there.</ErrorBanner>
            )}
            <button className={shared["login-submit"]} type="submit" disabled={busy || typed.trim() === ""}>
                {busy ? "Checking…" : "Continue"}
            </button>
        </form>
    );
}

/**
 * The approval prompt.
 *
 * A device has no identity to show, so the address and user-agent it asked from
 * are the only evidence a person can weigh. They are shown rather than tucked
 * away for exactly that reason: the attack this screen has to survive is being
 * read a code over the phone by someone else, and an unfamiliar address is the
 * only tell.
 */
function Confirm({ request, username, busy, onAnswer }: {
    request: DeviceAuthorizationRequest;
    username: string;
    busy: boolean;
    onAnswer(decision: "approved" | "denied"): void;
}) {
    return (
        <>
            <p className={shared["login-subtitle"]}>
                Connect <strong>{request.appName}</strong> as <strong>{username}</strong>?
            </p>
            <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 12px", margin: 0, fontSize: 12 }}>
                <dt style={{ color: colorVars.muted }}>Code</dt>
                <dd style={{ margin: 0 }}><code>{request.userCode}</code></dd>
                <dt style={{ color: colorVars.muted }}>From</dt>
                <dd style={{ margin: 0 }}><code>{request.ip ?? "unknown address"}</code></dd>
                <dt style={{ color: colorVars.muted }}>Device</dt>
                <dd style={{ margin: 0, wordBreak: "break-word" }}>{request.userAgent ?? "did not identify itself"}</dd>
                <dt style={{ color: colorVars.muted }}>Requested</dt>
                <dd style={{ margin: 0 }}>{new Date(request.requestedAt).toLocaleString()}</dd>
            </dl>
            <p style={{ fontSize: 12, color: colorVars.muted, margin: 0 }}>
                If you didn&apos;t just start this on a device of your own, refuse it.
            </p>
            <button className={shared["login-submit"]} type="button" disabled={busy} onClick={() => onAnswer("approved")}>
                {busy ? "Connecting…" : "Connect device"}
            </button>
            <button className={shared.btn} type="button" disabled={busy} onClick={() => onAnswer("denied")}>
                Refuse
            </button>
        </>
    );
}
