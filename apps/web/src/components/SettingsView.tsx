import { useState, useEffect } from "react";
import { api } from "../api";
import { useConnection } from "../hooks/useConnection";
import { UsersTab } from "./settings/UsersTab";
import { OidcClientsTab } from "./settings/OidcClientsTab";
import { DebugTab } from "./settings/DebugTab";
import { cx } from "../utils";
import shared from "../styles/shared.module.css";
import uiStyles from "./ui.module.css";
import { colorVars } from "../styles/colorVars";

interface ControlPlaneStatus {
    version: string;
    installed: boolean;
    latestVersion: string | null;
    updateAvailable: boolean;
}

type SettingsTab = "general" | "users" | "oidc" | "debug";

const TABS: Array<{ id: SettingsTab; label: string }> = [
    { id: "general", label: "General" },
    { id: "users", label: "Users" },
    { id: "oidc", label: "SSO Clients" },
    { id: "debug", label: "Debug" },
];

function GeneralSettings() {
    const [domain, setDomain] = useState<string>("");
    const [saved, setSaved] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [primaryUrl, setPrimaryUrl] = useState<string>("");
    const [primarySaved, setPrimarySaved] = useState<string | null>(null);
    const [primarySaving, setPrimarySaving] = useState(false);
    const [primaryError, setPrimaryError] = useState<string | null>(null);
    /** SSO clients trusting the saved primary URL as their token issuer. Non-zero
     *  means a change needs confirming, since it breaks their sign-in. */
    const [oidcClientCount, setOidcClientCount] = useState(0);

    // The saved list, plus the draft in the add field. Entries are added and removed
    // whole rather than edited in place: each one is a single short URL, so editing
    // buys nothing over remove-and-re-add, and validating on add keeps a malformed
    // origin from ever reaching the list.
    // Each trusted proxy is an address plus, optionally, the header that proxy
    // writes — empty meaning "the default below". Same add/remove shape as the
    // origins list; editing in place would need per-row draft state for no gain.
    const [proxies, setProxies] = useState<{ address: string; header: string }[]>([]);
    const [proxyDraft, setProxyDraft] = useState("");
    const [proxyHeaderDraft, setProxyHeaderDraft] = useState("");
    const [forwardedHeader, setForwardedHeader] = useState("x-forwarded-for");
    const [proxiesLocked, setProxiesLocked] = useState(false);
    const [proxiesSaving, setProxiesSaving] = useState(false);
    const [proxiesError, setProxiesError] = useState<string | null>(null);

    const [allowedOrigins, setAllowedOrigins] = useState<string[]>([]);
    const [originDraft, setOriginDraft] = useState("");
    const [originsSaving, setOriginsSaving] = useState(false);
    const [originsError, setOriginsError] = useState<string | null>(null);

    const [cp, setCp] = useState<ControlPlaneStatus | null>(null);
    const [updating, setUpdating] = useState(false);
    const [cpMsg, setCpMsg] = useState<string | null>(null);

    // Latest control-plane WAN IP check (a `find_wan_ip` task run, newest first).
    const { tasks } = useConnection();
    const wanRun = tasks.find((t) => t.target === null && t.spec.kind === "find_wan_ip");
    const wanInFlight = wanRun?.status === "pending" || wanRun?.status === "running";

    async function checkWanIp() {
        try {
            await api("runTask", { spec: { kind: "find_wan_ip" }, target: null });
        } catch { /* surfaced via the run's failed status */ }
    }

    useEffect(() => {
        api("getConfig", undefined).then((c) => {
            setDomain(c.domain ?? "");
            setSaved(c.domain ?? null);
            setPrimaryUrl(c.primaryUrl ?? "");
            setPrimarySaved(c.primaryUrl ?? null);
            setOidcClientCount(c.oidcClientCount);
            setAllowedOrigins(c.allowedOrigins);
            setProxies(c.trustedProxies);
            setForwardedHeader(c.forwardedHeader);
            setProxiesLocked(c.trustedProxiesLocked);
        }).catch(() => { /* ignore */ });
        api("getControlPlaneStatus", undefined).then(setCp).catch(() => { /* ignore */ });
    }, []);

    async function handleSavePrimaryUrl(e: React.FormEvent) {
        e.preventDefault();
        setPrimarySaving(true);
        setPrimaryError(null);
        const trimmed = primaryUrl.trim() || null;
        try {
            await api("setPrimaryUrl", { primaryUrl: trimmed });
            setPrimarySaved(trimmed);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // The server refuses a change that would break registered SSO clients
            // rather than asking first, so the confirmation happens here.
            if (message.includes("will break sign-in for")) {
                if (confirm(`${message}\n\nChange it anyway?`)) {
                    try {
                        await api("setPrimaryUrl", { primaryUrl: trimmed, force: true });
                        setPrimarySaved(trimmed);
                    } catch (forced) {
                        setPrimaryError(forced instanceof Error ? forced.message : String(forced));
                    }
                }
            } else {
                setPrimaryError(message);
            }
        } finally {
            setPrimarySaving(false);
        }
    }

    /** Persist a whole list, then adopt what the server stored — it normalizes
     *  ("https://x/" becomes "https://x"), so re-reading keeps the displayed list
     *  identical to the saved one instead of merely similar. */
    async function saveOrigins(next: string[]): Promise<boolean> {
        setOriginsSaving(true);
        setOriginsError(null);
        try {
            await api("setAllowedOrigins", { allowedOrigins: next });
            setAllowedOrigins((await api("getConfig", undefined)).allowedOrigins);
            return true;
        } catch (err) {
            setOriginsError(err instanceof Error ? err.message : String(err));
            return false;
        } finally {
            setOriginsSaving(false);
        }
    }

    async function handleAddOrigin(e: React.FormEvent) {
        e.preventDefault();
        const entry = originDraft.trim();
        if (!entry) {
            return;
        }
        // Checked here as well as on the server so a typo is rejected against the
        // field the user is still looking at, rather than after a round trip.
        if (entry !== "*") {
            let url: URL;
            try {
                url = new URL(entry);
            } catch {
                setOriginsError(`"${entry}" isn't a valid URL — include the scheme, e.g. https://app.example.com`);
                return;
            }
            if (url.protocol !== "http:" && url.protocol !== "https:") {
                setOriginsError("Origins must be http or https");
                return;
            }
            if (allowedOrigins.includes(url.origin)) {
                setOriginsError(`${url.origin} is already allowed`);
                return;
            }
        }
        if (await saveOrigins([...allowedOrigins, entry])) {
            setOriginDraft("");
        }
    }

    async function handleRemoveOrigin(origin: string) {
        await saveOrigins(allowedOrigins.filter((o) => o !== origin));
    }

    async function saveProxies(next: { address: string; header: string }[]): Promise<boolean> {
        setProxiesSaving(true);
        setProxiesError(null);
        try {
            await api("setTrustedProxies", { trustedProxies: next });
            const saved = await api("getConfig", undefined);
            setProxies(saved.trustedProxies);
            return true;
        } catch (err) {
            setProxiesError(err instanceof Error ? err.message : String(err));
            return false;
        } finally {
            setProxiesSaving(false);
        }
    }

    async function handleAddProxy(e: React.FormEvent) {
        e.preventDefault();
        const address = proxyDraft.trim();
        if (!address) {
            return;
        }
        if (proxies.some((p) => p.address === address)) {
            setProxiesError(`${address} is already trusted`);
            return;
        }
        if (await saveProxies([...proxies, { address, header: proxyHeaderDraft.trim() }])) {
            setProxyDraft("");
            setProxyHeaderDraft("");
        }
    }

    async function handleRemoveProxy(address: string) {
        await saveProxies(proxies.filter((p) => p.address !== address));
    }

    async function handleUpdateControlPlane() {
        if (!confirm("Update the control plane? It downloads the new version and restarts — this page will briefly disconnect, then reconnect.")) {
            return;
        }
        setUpdating(true);
        setCpMsg(null);
        try {
            await api("updateControlPlane", undefined);
            setCpMsg("Update started; the control plane is restarting. This page will reconnect shortly.");
        } catch (err) {
            setCpMsg(err instanceof Error ? err.message : String(err));
            setUpdating(false);
        }
    }

    async function handleSave(e: React.FormEvent) {
        e.preventDefault();
        setSaving(true);
        setError(null);
        try {
            const trimmed = domain.trim() || null;
            await api("setDomain", { domain: trimmed });
            setSaved(trimmed);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    async function handleClear() {
        setSaving(true);
        setError(null);
        try {
            await api("setDomain", { domain: null });
            setDomain("");
            setSaved(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    return (
        <div>
            <div style={{ maxWidth: 480, marginBottom: 28 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>Control plane</h2>
                {cp ? (
                    <>
                        <p style={{ margin: "0 0 12px", color: colorVars.muted, fontSize: 13 }}>
                            Version <code>{cp.version}</code>
                            {cp.latestVersion && cp.latestVersion !== cp.version && <> · latest <code>{cp.latestVersion}</code></>}
                            {!cp.installed && " — not installed as a service"}
                        </p>
                        {cp.updateAvailable && (
                            <button className={cx(shared.btn, shared["btn-primary"])} type="button" disabled={updating} onClick={handleUpdateControlPlane}>
                                {updating ? "Updating…" : `Update to ${cp.latestVersion}`}
                            </button>
                        )}
                        {cp.installed && !cp.updateAvailable && cp.latestVersion && (
                            <div style={{ fontSize: 12, color: colorVars.muted }}>Up to date.</div>
                        )}
                        {!cp.installed && (
                            <div style={{ fontSize: 12, color: colorVars.muted }}>
                                Self-update is available once the control plane is installed as a service.
                            </div>
                        )}
                        {cpMsg && <div style={{ marginTop: 8, fontSize: 12, color: colorVars.muted }}>{cpMsg}</div>}
                    </>
                ) : (
                    <p style={{ margin: 0, color: colorVars.muted, fontSize: 13 }}>Loading…</p>
                )}
            </div>

            <div style={{ maxWidth: 480, marginBottom: 28 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>External (WAN) IP</h2>
                <p style={{ margin: "0 0 12px", color: colorVars.muted, fontSize: 13 }}>
                    The control plane's public IP, discovered via STUN.
                </p>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <button className={shared.btn} type="button" disabled={wanInFlight} onClick={checkWanIp}>
                        {wanInFlight ? "Checking…" : "Check now"}
                    </button>
                    {wanRun && !wanInFlight && (
                        <span style={{ fontSize: 13, color: colorVars.muted }}>
                            {wanRun.status === "failed"
                                ? `Failed: ${wanRun.error ?? "unknown error"}`
                                : <>
                                    <code>{wanRun.result?.kind === "find_wan_ip" ? wanRun.result.ip ?? "not detected" : "—"}</code>
                                    {wanRun.finishedAt && ` · ${new Date(wanRun.finishedAt).toLocaleString()}`}
                                </>}
                        </span>
                    )}
                </div>
            </div>

            <div style={{ maxWidth: 480, marginBottom: 28 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>Primary URL</h2>
                <p style={{ margin: "0 0 12px", color: colorVars.muted, fontSize: 13 }}>
                    The canonical address people reach this control plane at, including the scheme —
                    <code> https://sc.example.com</code>. Set it to what browsers see, which behind a
                    reverse proxy is the proxy's hostname, not this machine's.
                </p>
                <p style={{ margin: "0 0 12px", color: colorVars.muted, fontSize: 12 }}>
                    Used as the OIDC token issuer, and by anything that needs to name this server
                    from outside it. Required before registering SSO clients.
                </p>

                <form onSubmit={handleSavePrimaryUrl} style={{ display: "flex", gap: 8 }}>
                    <input
                        type="text"
                        placeholder="https://central.example.com"
                        value={primaryUrl}
                        onChange={(e) => setPrimaryUrl(e.target.value)}
                        style={{ flex: 1 }}
                    />
                    <button className={cx(shared.btn, shared["btn-primary"])} type="submit" disabled={primarySaving}>
                        {primarySaving ? "Saving…" : "Save"}
                    </button>
                </form>

                {primaryError && <div className={uiStyles["error-banner"]} style={{ marginTop: 8 }}>{primaryError}</div>}

                {primarySaved && (
                    <div style={{ marginTop: 8, fontSize: 12, color: colorVars.muted }}>
                        Current: <code>{primarySaved}</code>
                        {oidcClientCount > 0 && (
                            <> · {oidcClientCount} SSO client{oidcClientCount === 1 ? " trusts" : "s trust"} this as their
                            token issuer, so changing it breaks their sign-in until they're reconfigured.</>
                        )}
                    </div>
                )}
            </div>

            <div style={{ maxWidth: 480, marginBottom: 28 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>Trusted proxies</h2>
                <p style={{ margin: "0 0 12px", color: colorVars.muted, fontSize: 13 }}>
                    Reverse proxies in front of this server, as an IP or CIDR range. Only these are
                    believed when a request claims to be forwarded on someone else's behalf — without
                    them, every request looks like it came from the proxy.
                </p>
                <p style={{ margin: "0 0 12px", color: colorVars.muted, fontSize: 12 }}>
                    The header is optional and defaults to <code>{forwardedHeader}</code>. Set it per
                    proxy only when they differ — an internal nginx writing <code>X-Real-IP</code>
                    alongside a CDN tunnel writing <code>CF-Connecting-IP</code>, say.
                </p>

                {proxiesLocked ? (
                    <div style={{ marginBottom: 10, fontSize: 12, color: colorVars.muted }}>
                        Set by <code>SC_TRUSTED_PROXIES</code> in the environment, so it can't be changed here.
                    </div>
                ) : (
                    <>
                        <div className={uiStyles["error-banner"]} style={{ marginBottom: 10, fontSize: 12 }}>
                            These entries don't route traffic — they decide whose forwarded client address
                            is believed. Delete the one for the proxy in front of this server and requests
                            keep arriving, but all from the proxy's own address: one person's failed
                            sign-ins would then throttle everyone. Recoverable by editing <code>config.json</code>.
                        </div>

                        <form onSubmit={handleAddProxy} style={{ display: "flex", gap: 8 }}>
                            <input
                                type="text"
                                placeholder="127.0.0.1 or 10.42.0.0/16"
                                value={proxyDraft}
                                onChange={(e) => { setProxyDraft(e.target.value); setProxiesError(null); }}
                                style={{ flex: 2 }}
                            />
                            <input
                                type="text"
                                placeholder={forwardedHeader}
                                value={proxyHeaderDraft}
                                onChange={(e) => { setProxyHeaderDraft(e.target.value); setProxiesError(null); }}
                                style={{ flex: 2 }}
                            />
                            <button
                                className={cx(shared.btn, shared["btn-primary"])}
                                type="submit"
                                disabled={proxiesSaving || !proxyDraft.trim()}
                            >
                                Add
                            </button>
                        </form>
                    </>
                )}

                {proxiesError && <div className={uiStyles["error-banner"]} style={{ marginTop: 8 }}>{proxiesError}</div>}

                {proxies.length === 0 ? (
                    <div style={{ marginTop: 10, fontSize: 12, color: colorVars.muted }}>
                        No trusted proxies — the client IP is whoever connects, and forwarded headers are ignored.
                    </div>
                ) : (
                    <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
                        {proxies.map((p) => (
                            <li
                                key={p.address}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: 8,
                                    padding: "6px 0",
                                    borderTop: `1px solid ${colorVars.border}`,
                                }}
                            >
                                <span style={{ overflowWrap: "anywhere" }}>
                                    <code className={shared.mono} style={{ fontSize: 12 }}>{p.address}</code>
                                    <span style={{ fontSize: 12, color: colorVars.muted }}>
                                        {" → "}{p.header || forwardedHeader}{p.header ? "" : " (default)"}
                                    </span>
                                </span>
                                {!proxiesLocked && (
                                    <button
                                        className={cx(shared.btn, shared["btn-sm"])}
                                        type="button"
                                        disabled={proxiesSaving}
                                        onClick={() => void handleRemoveProxy(p.address)}
                                    >
                                        Remove
                                    </button>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div style={{ maxWidth: 480, marginBottom: 28 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>Allowed origins</h2>
                <p style={{ margin: "0 0 12px", color: colorVars.muted, fontSize: 13 }}>
                    Optional, one per line. Other sites permitted to call this API from a browser —
                    a separate app's frontend, say. This page needs no entry: it's served from the
                    same origin as the API.
                </p>
                <p style={{ margin: "0 0 12px", color: colorVars.muted, fontSize: 12 }}>
                    Empty allows any origin, which is the default. Note this controls whether a
                    browser hands the <em>response</em> back to another site — it doesn't stop a
                    request reaching the server.
                </p>

                <form onSubmit={handleAddOrigin} style={{ display: "flex", gap: 8 }}>
                    <input
                        type="text"
                        placeholder="https://app.example.com"
                        value={originDraft}
                        onChange={(e) => { setOriginDraft(e.target.value); setOriginsError(null); }}
                        style={{ flex: 1 }}
                    />
                    <button
                        className={cx(shared.btn, shared["btn-primary"])}
                        type="submit"
                        disabled={originsSaving || !originDraft.trim()}
                    >
                        Add
                    </button>
                </form>

                {originsError && <div className={uiStyles["error-banner"]} style={{ marginTop: 8 }}>{originsError}</div>}

                {allowedOrigins.length === 0 ? (
                    <div style={{ marginTop: 10, fontSize: 12, color: colorVars.muted }}>
                        No origins listed — any origin may call the API.
                    </div>
                ) : (
                    <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0 }}>
                        {allowedOrigins.map((origin) => (
                            <li
                                key={origin}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: 8,
                                    padding: "6px 0",
                                    borderTop: `1px solid ${colorVars.border}`,
                                }}
                            >
                                <code className={shared.mono} style={{ fontSize: 12, overflowWrap: "anywhere" }}>{origin}</code>
                                <button
                                    className={cx(shared.btn, shared["btn-sm"])}
                                    type="button"
                                    disabled={originsSaving}
                                    onClick={() => void handleRemoveOrigin(origin)}
                                >
                                    Remove
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>


            <div style={{ maxWidth: 480 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>External domain for agents</h2>
                <p style={{ margin: "0 0 12px", color: colorVars.muted, fontSize: 13 }}>
                    Optional. When set, the node install command will include this domain as an alternate control-plane address,
                    allowing nodes outside your LAN to connect.
                </p>
                <p style={{ margin: "0 0 12px", color: colorVars.muted, fontSize: 12 }}>
                    The address <strong>agents</strong> dial on port 4142 — not the address you load this page from
                    (that's <strong>Primary URL</strong> above). They're the same name only if it resolves to this host and
                    4142 is reachable on it; behind a reverse proxy on a separate machine, keep this pointing here.
                </p>

                <form onSubmit={handleSave} style={{ display: "flex", gap: 8 }}>
                    <input
                        type="text"
                        placeholder="e.g. central.example.com"
                        value={domain}
                        onChange={(e) => setDomain(e.target.value)}
                        style={{ flex: 1 }}
                    />
                    <button className={cx(shared.btn, shared["btn-primary"])} type="submit" disabled={saving}>
                        {saving ? "Saving…" : "Save"}
                    </button>
                    {saved && (
                        <button className={shared.btn} type="button" disabled={saving} onClick={handleClear}>
                            Clear
                        </button>
                    )}
                </form>

                {error && <div className={uiStyles["error-banner"]} style={{ marginTop: 8 }}>{error}</div>}

                {saved && (
                    <div style={{ marginTop: 8, fontSize: 12, color: colorVars.muted }}>
                        Current: <code>{saved}</code>
                    </div>
                )}
            </div>
        </div>
    );
}

export function SettingsView() {
    const [tab, setTab] = useState<SettingsTab>("general");

    return (
        <div className={shared.view}>
            <header className={shared["view-header"]}>
                <h1>Settings</h1>
            </header>

            <nav className={shared["sub-tabs"]} style={{ marginBottom: 20 }}>
                {TABS.map((t) => (
                    <button
                        key={t.id}
                        className={cx(shared["sub-tab"], tab === t.id && shared.active)}
                        onClick={() => setTab(t.id)}
                    >
                        {t.label}
                    </button>
                ))}
            </nav>

            {tab === "general" && <GeneralSettings />}
            {tab === "users" && <UsersTab />}
            {tab === "oidc" && <OidcClientsTab />}
            {tab === "debug" && <DebugTab />}
        </div>
    );
}
