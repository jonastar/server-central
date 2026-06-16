import { useState, useEffect } from "react";
import { api } from "../api";

export function SettingsView() {
    const [domain, setDomain] = useState<string>("");
    const [saved, setSaved] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        api("getConfig", undefined).then((c) => {
            setDomain(c.domain ?? "");
            setSaved(c.domain ?? null);
        }).catch(() => { /* ignore */ });
    }, []);

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
