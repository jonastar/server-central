import { useState, useEffect } from "react";
import { api } from "../api";

interface ControlPlaneStatus {
    version: string;
    installed: boolean;
    latestVersion: string | null;
    updateAvailable: boolean;
}

export function SettingsView() {
    const [domain, setDomain] = useState<string>("");
    const [saved, setSaved] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [cp, setCp] = useState<ControlPlaneStatus | null>(null);
    const [updating, setUpdating] = useState(false);
    const [cpMsg, setCpMsg] = useState<string | null>(null);

    useEffect(() => {
        api("getConfig", undefined).then((c) => {
            setDomain(c.domain ?? "");
            setSaved(c.domain ?? null);
        }).catch(() => { /* ignore */ });
        api("getControlPlaneStatus", undefined).then(setCp).catch(() => { /* ignore */ });
    }, []);

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
        <div className="view">
            <header className="view-header">
                <h1>Settings</h1>
            </header>

            <div style={{ maxWidth: 480, marginBottom: 28 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>Control plane</h2>
                {cp ? (
                    <>
                        <p style={{ margin: "0 0 12px", color: "var(--fg-muted)", fontSize: 13 }}>
                            Version <code>{cp.version}</code>
                            {cp.latestVersion && cp.latestVersion !== cp.version && <> · latest <code>{cp.latestVersion}</code></>}
                            {!cp.installed && " — not installed as a service"}
                        </p>
                        {cp.updateAvailable && (
                            <button className="btn btn-primary" type="button" disabled={updating} onClick={handleUpdateControlPlane}>
                                {updating ? "Updating…" : `Update to ${cp.latestVersion}`}
                            </button>
                        )}
                        {cp.installed && !cp.updateAvailable && cp.latestVersion && (
                            <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>Up to date.</div>
                        )}
                        {!cp.installed && (
                            <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                                Self-update is available once the control plane is installed as a service.
                            </div>
                        )}
                        {cpMsg && <div style={{ marginTop: 8, fontSize: 12, color: "var(--fg-muted)" }}>{cpMsg}</div>}
                    </>
                ) : (
                    <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 13 }}>Loading…</p>
                )}
            </div>

            <div style={{ maxWidth: 480 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>External domain</h2>
                <p style={{ margin: "0 0 12px", color: "var(--fg-muted)", fontSize: 13 }}>
                    Optional. When set, the node install command will include this domain as an alternate control-plane address,
                    allowing nodes outside your LAN to connect.
                </p>

                <form onSubmit={handleSave} style={{ display: "flex", gap: 8 }}>
                    <input
                        type="text"
                        className="input"
                        placeholder="e.g. central.example.com"
                        value={domain}
                        onChange={(e) => setDomain(e.target.value)}
                        style={{ flex: 1 }}
                    />
                    <button className="btn btn-primary" type="submit" disabled={saving}>
                        {saving ? "Saving…" : "Save"}
                    </button>
                    {saved && (
                        <button className="btn" type="button" disabled={saving} onClick={handleClear}>
                            Clear
                        </button>
                    )}
                </form>

                {error && <div className="error-banner" style={{ marginTop: 8 }}>{error}</div>}

                {saved && (
                    <div style={{ marginTop: 8, fontSize: 12, color: "var(--fg-muted)" }}>
                        Current: <code>{saved}</code>
                    </div>
                )}
            </div>
        </div>
    );
}
