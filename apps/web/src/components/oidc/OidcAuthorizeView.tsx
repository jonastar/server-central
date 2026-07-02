import { useEffect, useState } from "react";
import type { OidcAuthorizeParams } from "@central/shared";
import { api } from "../../api";
import { useAuth } from "../../hooks/useAuth";
import { LoginView } from "../LoginView";
import { EmptyState, ErrorBanner } from "../ui";

/** Reads the OIDC authorization request off the real query string (this route is
 *  reached via a browser redirect from the relying party, not hash routing). */
function parseParams(): OidcAuthorizeParams | null {
    const q = new URLSearchParams(window.location.search);
    const clientId = q.get("client_id");
    const redirectUri = q.get("redirect_uri");
    const codeChallenge = q.get("code_challenge");
    if (!clientId || !redirectUri || q.get("response_type") !== "code"
        || !codeChallenge || q.get("code_challenge_method") !== "S256") {
        return null;
    }
    return {
        clientId,
        redirectUri,
        scope: q.get("scope") ?? "",
        state: q.get("state") ?? "",
        codeChallenge,
        codeChallengeMethod: "S256",
        nonce: q.get("nonce") ?? undefined,
    };
}

/**
 * Top-level route (mounted directly by main.tsx, not the hash router) for
 * `GET /oidc/authorize` redirects from relying parties. Reuses the normal
 * login/setup screens via `useAuth()`, then shows a lightweight identity
 * confirmation ("Continue as X to <client>?") instead of a scope-consent
 * screen — every client here was registered by the owner, so registration
 * itself stands in for consent.
 */
export function OidcAuthorizeView() {
    const auth = useAuth();
    const [params] = useState(parseParams);
    const [request, setRequest] = useState<{ clientName: string; redirectUri: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!auth.user || !params) {
            return;
        }
        api("getOidcAuthorizeRequest", params)
            .then(setRequest)
            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, [auth.user, params]);

    async function handleContinue() {
        if (!params) {
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const { redirectUrl } = await api("completeOidcAuthorize", params);
            window.location.href = redirectUrl;
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setBusy(false);
        }
    }

    if (!params) {
        return (
            <div className="login-screen">
                <div className="login-card">
                    <h1 className="login-title">Server Central</h1>
                    <ErrorBanner>This sign-in link is invalid or incomplete.</ErrorBanner>
                </div>
            </div>
        );
    }

    if (auth.loading) {
        return <EmptyState>Loading…</EmptyState>;
    }
    if (auth.needsSetup) {
        return <LoginView mode="setup" onSubmit={auth.setup} />;
    }
    if (!auth.user) {
        return <LoginView mode="login" onSubmit={auth.login} />;
    }

    return (
        <div className="login-screen">
            <div className="login-card">
                <h1 className="login-title">Server Central</h1>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                {!request ? (
                    <p className="login-subtitle">Loading request…</p>
                ) : (
                    <>
                        <p className="login-subtitle">
                            Continue as <strong>{auth.user.username}</strong> to <strong>{request.clientName}</strong>?
                        </p>
                        <p style={{ fontSize: 12, color: "var(--fg-muted)", marginTop: -8 }}>
                            You'll be redirected to <code>{request.redirectUri}</code>.
                        </p>
                        <button className="login-submit" type="button" disabled={busy} onClick={() => void handleContinue()}>
                            {busy ? "Continuing…" : "Continue"}
                        </button>
                        <button className="btn" type="button" style={{ marginTop: 8 }} disabled={busy} onClick={() => void auth.logout()}>
                            Not you? Sign out
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}
