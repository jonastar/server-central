import { useEffect, useState } from "react";
import type { App } from "@central/shared";
import { api } from "../../api";
import { EmptyState, ErrorBanner, Modal } from "../ui";

function AddAppModal({ onClose, onCreated }: { onClose: () => void; onCreated: (app: App) => void }) {
    const [name, setName] = useState("");
    const [redirectUris, setRedirectUris] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [created, setCreated] = useState<{ app: App; clientSecret: string } | null>(null);
    const [copied, setCopied] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            const uris = redirectUris.split("\n").map((s) => s.trim()).filter(Boolean);
            const result = await api("createApp", { name, redirectUris: uris });
            setCreated(result);
            onCreated(result.app);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function handleCopy() {
        if (!created) {
            return;
        }
        await navigator.clipboard.writeText(created.clientSecret);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }

    // The secret only exists in memory here — once this modal closes it's gone
    // for good (only the hash is persisted server-side).
    if (created) {
        return (
            <Modal title="App created" onClose={onClose} width={480}>
                <p style={{ marginTop: 0, color: "var(--fg-muted)" }}>
                    This is the only time the client secret is shown — copy it into the app's config now.
                </p>
                <label className="login-field">
                    <span>Client ID</span>
                    <input className="input" readOnly value={created.app.id} />
                </label>
                <label className="login-field">
                    <span>Client secret</span>
                    <div style={{ display: "flex", gap: 8 }}>
                        <input className="input" readOnly value={created.clientSecret} style={{ flex: 1 }} />
                        <button type="button" className={`btn${copied ? " btn-primary" : ""}`} onClick={handleCopy}>
                            {copied ? "Copied!" : "Copy"}
                        </button>
                    </div>
                </label>
                <div className="modal-actions" style={{ marginTop: 16 }}>
                    <button className="btn btn-primary" onClick={onClose}>Done</button>
                </div>
            </Modal>
        );
    }

    return (
        <Modal title="Add app" onClose={onClose} width={480}>
            <form onSubmit={handleSubmit}>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <label className="login-field">
                    <span>Name</span>
                    <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className="login-field">
                    <span>Redirect URIs (one per line)</span>
                    <textarea
                        className="input"
                        rows={3}
                        value={redirectUris}
                        onChange={(e) => setRedirectUris(e.target.value)}
                        placeholder="https://app.example.com/callback"
                    />
                </label>
                <div className="modal-actions" style={{ marginTop: 16 }}>
                    <button className="btn" type="button" onClick={onClose}>Cancel</button>
                    <button className="btn btn-primary" type="submit" disabled={busy}>
                        {busy ? "Creating…" : "Create"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

export function AppsTab() {
    const [apps, setApps] = useState<App[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);

    function refresh() {
        api("listApps", undefined).then(setApps).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }

    useEffect(refresh, []);

    async function handleDelete(app: App) {
        if (!confirm(`Delete app "${app.name}"? Anything using it will stop being able to sign in.`)) {
            return;
        }
        setBusyId(app.id);
        setError(null);
        try {
            await api("deleteApp", { appId: app.id });
            refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyId(null);
        }
    }

    return (
        <div>
            {error && <ErrorBanner>{error}</ErrorBanner>}

            <div style={{ marginBottom: 12 }}>
                <button className="btn btn-primary" onClick={() => setAdding(true)}>Add app</button>
            </div>

            {apps === null ? (
                <EmptyState>Loading…</EmptyState>
            ) : apps.length === 0 ? (
                <EmptyState>No apps registered.</EmptyState>
            ) : (
                <section className="panel">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Client ID</th>
                                <th>Redirect URIs</th>
                                <th>Created</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {apps.map((a) => (
                                <tr key={a.id}>
                                    <td className="file-name">{a.name}</td>
                                    <td className="mono dim">{a.id}</td>
                                    <td className="dim">{a.redirectUris.join(", ")}</td>
                                    <td className="dim">{new Date(a.createdAt).toLocaleString()}</td>
                                    <td className="row-actions-always">
                                        <button className="btn" disabled={busyId === a.id} onClick={() => void handleDelete(a)}>
                                            Delete
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}

            {adding && (
                <AddAppModal
                    onClose={() => setAdding(false)}
                    onCreated={(app) => setApps((prev) => [...(prev ?? []), app])}
                />
            )}
        </div>
    );
}
