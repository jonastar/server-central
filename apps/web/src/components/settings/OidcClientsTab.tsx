import { useEffect, useState } from "react";
import type { App, OidcClient } from "@central/shared";
import { api } from "../../api";
import { EmptyState, ErrorBanner, Modal } from "../ui";
import { cx, copyToClipboard } from "../../utils";
import shared from "../../styles/shared.module.css";
import { colorVars } from "../../styles/colorVars";

function AddClientModal({ apps, onClose, onCreated }: { apps: App[]; onClose: () => void; onCreated: (client: OidcClient) => void }) {
    const [name, setName] = useState("");
    const [redirectUris, setRedirectUris] = useState("");
    const [appId, setAppId] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [created, setCreated] = useState<{ client: OidcClient; clientSecret: string } | null>(null);
    const [copied, setCopied] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            const uris = redirectUris.split("\n").map((s) => s.trim()).filter(Boolean);
            const result = await api("oidc", "createClient", { name, redirectUris: uris, appId: appId || null });
            setCreated(result);
            onCreated(result.client);
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
        await copyToClipboard(created.clientSecret);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }

    // The secret only exists in memory here — once this modal closes it's gone
    // for good (only the hash is persisted server-side).
    if (created) {
        return (
            <Modal title="Client created" onClose={onClose} width={480}>
                <p style={{ marginTop: 0, color: colorVars.muted }}>
                    This is the only time the client secret is shown — copy it into the client's config now.
                </p>
                <label className={shared["login-field"]}>
                    <span>Client ID</span>
                    <input readOnly value={created.client.id} />
                </label>
                <label className={shared["login-field"]}>
                    <span>Client secret</span>
                    <div style={{ display: "flex", gap: 8 }}>
                        <input readOnly value={created.clientSecret} style={{ flex: 1 }} />
                        <button type="button" className={cx(shared.btn, copied && shared["btn-primary"])} onClick={handleCopy}>
                            {copied ? "Copied!" : "Copy"}
                        </button>
                    </div>
                </label>
                <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                    <button className={cx(shared.btn, shared["btn-primary"])} onClick={onClose}>Done</button>
                </div>
            </Modal>
        );
    }

    return (
        <Modal title="Add OIDC client" onClose={onClose} width={480}>
            <form onSubmit={handleSubmit}>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <label className={shared["login-field"]}>
                    <span>Name</span>
                    <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label className={shared["login-field"]}>
                    <span>Redirect URIs (one per line)</span>
                    <textarea
                        rows={3}
                        value={redirectUris}
                        onChange={(e) => setRedirectUris(e.target.value)}
                        placeholder="https://app.example.com/callback"
                    />
                </label>
                <label className={shared["login-field"]}>
                    <span>App (optional)</span>
                    <select value={appId} onChange={(e) => setAppId(e.target.value)}>
                        <option value="">Not linked — sends every app role</option>
                        {apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                    <span className={shared.dim} style={{ fontSize: 12 }}>
                        {appId
                            ? <>Limits the <code>groups</code> claim to <code>app.{apps.find((a) => a.id === appId)?.slug}.*</code>, so this client is not told which roles the user holds in your other apps.</>
                            : <>Unlinked clients receive every <code>app.*</code> role the user holds, including roles belonging to your other apps. Register the app under Settings → Apps to scope it.</>}
                    </span>
                </label>
                <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                    <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                    <button className={cx(shared.btn, shared["btn-primary"])} type="submit" disabled={busy}>
                        {busy ? "Creating…" : "Create"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

/** How a client's group scoping reads in the list: the linked App, a legacy
 *  direct prefix from before Apps existed, or the unscoped default. */
function appLabel(client: OidcClient, apps: App[]) {
    const app = apps.find((a) => a.id === client.appId);
    if (app) {
        return <span className={shared.mono}>app.{app.slug}.*</span>;
    }
    if (client.groupPrefix) {
        return <span className={shared.mono}>app.{client.groupPrefix}.*</span>;
    }
    return <span className={shared.dim}>all app.*</span>;
}

export function OidcClientsTab() {
    const [clients, setClients] = useState<OidcClient[] | null>(null);
    const [apps, setApps] = useState<App[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);

    function refresh() {
        api("oidc", "listClients", undefined).then(setClients).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }

    useEffect(refresh, []);
    // Registered apps drive the link dropdown; an empty list just means every
    // client stays unscoped, so a failure here is not worth an error banner.
    useEffect(() => { api("apps", "list", undefined).then(setApps).catch(() => setApps([])); }, []);

    async function handleDelete(client: OidcClient) {
        if (!confirm(`Delete client "${client.name}"? Anything using it will stop being able to sign in.`)) {
            return;
        }
        setBusyId(client.id);
        setError(null);
        try {
            await api("oidc", "deleteClient", { clientId: client.id });
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
                <button className={cx(shared.btn, shared["btn-primary"])} onClick={() => setAdding(true)}>Add client</button>
            </div>

            {clients === null ? (
                <EmptyState>Loading…</EmptyState>
            ) : clients.length === 0 ? (
                <EmptyState>No OIDC clients registered.</EmptyState>
            ) : (
                <section className={shared.panel}>
                    <table className={shared["data-table"]}>
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Client ID</th>
                                <th>Redirect URIs</th>
                                <th>App</th>
                                <th>Created</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {clients.map((c) => (
                                <tr key={c.id}>
                                    <td className={shared["file-name"]}>{c.name}</td>
                                    <td className={cx(shared.mono, shared.dim)}>{c.id}</td>
                                    <td className={shared.dim}>{c.redirectUris.join(", ")}</td>
                                    <td className={shared.dim}>
                                        {appLabel(c, apps)}
                                    </td>
                                    <td className={shared.dim}>{new Date(c.createdAt).toLocaleString()}</td>
                                    <td className={shared["row-actions-always"]}>
                                        <button className={shared.btn} disabled={busyId === c.id} onClick={() => void handleDelete(c)}>
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
                <AddClientModal
                    apps={apps}
                    onClose={() => setAdding(false)}
                    onCreated={(client) => setClients((prev) => [...(prev ?? []), client])}
                />
            )}
        </div>
    );
}
