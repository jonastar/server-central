import { useEffect, useState, type ReactNode } from "react";
import { appRoleNode, type App, type OidcClient, type OidcProviderInfo } from "@central/shared";
import { api } from "../../api";
import { CopyButton, DetailPair, EmptyState, ErrorBanner, Modal } from "../ui";
import { cx } from "../../utils";
import shared from "../../styles/shared.module.css";
import { colorVars } from "../../styles/colorVars";

/** The scopes an app should ask for to get everything this provider offers
 *  short of refresh tokens, which are opt-in because they outlive the login. */
const RECOMMENDED_SCOPES = "openid profile email groups";

/** One copyable value the other app's config asks for, by the name it asks
 *  for it. Values are mono so a stray space is visible. */
function CopyRow({ label, value, note }: { label: string; value: string; note?: ReactNode }) {
    return (
        <DetailPair label={label}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                <code className={shared.mono} style={{ overflowWrap: "anywhere" }}>{value}</code>
                <CopyButton text={value} />
            </div>
            {note && <div className={shared.dim} style={{ fontSize: 12 }}>{note}</div>}
        </DetailPair>
    );
}

function SectionTitle({ children }: { children: ReactNode }) {
    return <h3 style={{ fontSize: 13, fontWeight: 600, margin: "16px 0 6px" }}>{children}</h3>;
}

/**
 * The provider half of an SSO setup: everything the other app asks for that
 * does not depend on which client it is. Most apps take the discovery URL and
 * work the rest out; the individual endpoints are for the ones that don't.
 *
 * Rendered from what `/.well-known` actually serves rather than a copy typed
 * here, so it cannot drift from what the app will fetch.
 */
function ProviderFields({ provider }: { provider: OidcProviderInfo }) {
    const d = provider.discovery;
    return (
        <>
            <CopyRow label="Issuer" value={d.issuer} />
            <CopyRow label="Discovery URL" value={provider.discoveryUrl} note="Apps that support OIDC discovery need only this." />
            <details style={{ marginTop: 6 }}>
                <summary className={shared.dim} style={{ fontSize: 12, cursor: "pointer" }}>
                    Individual endpoints, for apps that can't use discovery
                </summary>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                    <CopyRow label="Authorization" value={d.authorization_endpoint} />
                    <CopyRow label="Token" value={d.token_endpoint} />
                    <CopyRow label="Userinfo" value={d.userinfo_endpoint} />
                    <CopyRow label="JWKS" value={d.jwks_uri} />
                    <CopyRow label="Device auth" value={d.device_authorization_endpoint} />
                    <CopyRow label="Revocation" value={d.revocation_endpoint} />
                </div>
            </details>
            <DetailPair label="Requirements">
                <span style={{ fontSize: 13 }}>
                    Authorization code flow with PKCE (<code>S256</code>); client authentication
                    via <code>client_secret_post</code> or <code>client_secret_basic</code>;
                    ID tokens signed with <code>RS256</code>.
                </span>
            </DetailPair>
        </>
    );
}

/**
 * The `groups` values a client will actually see, spelled out so they can be
 * pasted into the other app's role-mapping screen instead of reconstructed
 * from the `app.<slug>.<role>` convention. Mirrors `groupsForClient` on the
 * server: a linked App with no declared roles is assumed to use `.admin`.
 */
function groupValues(client: OidcClient, apps: App[]): { scope: ReactNode; values: string[] } {
    const app = apps.find((a) => a.id === client.appId);
    if (app) {
        const values = app.roles.length > 0 ? app.roles.map((r) => appRoleNode(app, r)) : [appRoleNode(app, "admin")];
        return {
            scope: <>Only <code>app.{app.slug}.*</code> nodes. {app.roles.length === 0 && <>The app declares no roles, so <code>admin</code> is assumed — declare them under Settings → Apps to list the real ones.</>}</>,
            values,
        };
    }
    if (client.groupPrefix) {
        return {
            scope: <>Only <code>app.{client.groupPrefix}.*</code> nodes (legacy prefix; link an App to declare its roles).</>,
            values: [`app.${client.groupPrefix}.admin`],
        };
    }
    return {
        scope: <>Every <code>app.*</code> node the user holds, across all apps. Link this client to an App to scope it.</>,
        values: apps.flatMap((a) => a.roles.map((r) => appRoleNode(a, r))),
    };
}

/**
 * Everything to paste into the other app, in one place: the provider half, this
 * client's credentials, and the claim names and role values it will receive.
 *
 * Shown right after creation (the only time the secret is readable — the
 * server keeps a hash, exactly like a user password), after a secret rotation,
 * and on demand from the list minus the secret. The same modal in all three
 * cases so that what an admin sees on day one is what they can get back to.
 */
function ClientConfigModal({ title, client, clientSecret, provider, apps, onClose }: {
    title: string;
    client: OidcClient;
    clientSecret?: string;
    provider: OidcProviderInfo | null;
    apps: App[];
    onClose: () => void;
}) {
    const groups = groupValues(client, apps);
    return (
        <Modal title={title} onClose={onClose} width={620}>
            {clientSecret && (
                <p style={{ marginTop: 0, color: colorVars.muted }}>
                    This is the only time the client secret is shown — copy it into the app's config now.
                </p>
            )}

            <SectionTitle>Client</SectionTitle>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <CopyRow label="Client ID" value={client.id} />
                {clientSecret && <CopyRow label="Client secret" value={clientSecret} />}
                <DetailPair label="Redirect URIs">
                    {client.redirectUris.length > 0
                        ? client.redirectUris.map((u) => <div key={u}><code className={shared.mono}>{u}</code></div>)
                        : <span className={cx(shared.badge, shared["badge-warn"])}>None yet — sign-in fails until the app's callback URL is added (Edit)</span>}
                </DetailPair>
            </div>

            <SectionTitle>Provider</SectionTitle>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {provider
                    ? <ProviderFields provider={provider} />
                    : <span className={shared.dim}>Set a Primary URL under Settings → General to see the issuer and endpoints.</span>}
            </div>

            <SectionTitle>Claims</SectionTitle>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <CopyRow label="Scopes" value={RECOMMENDED_SCOPES} note={<>Add <code>offline_access</code> if the app needs refresh tokens (stays signed in without you present).</>} />
                <CopyRow label="Username claim" value="preferred_username" />
                <CopyRow label="Email claim" value="email" />
                <CopyRow label="Groups claim" value={provider?.groupsClaim ?? "groups"} note={groups.scope} />
                <DetailPair label="Role values">
                    {groups.values.length > 0
                        ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                {groups.values.map((v) => (
                                    <div key={v} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                        <code className={shared.mono}>{v}</code>
                                        <CopyButton text={v} />
                                    </div>
                                ))}
                            </div>
                        )
                        : <span className={shared.dim}>No app declares roles yet.</span>}
                </DetailPair>
            </div>

            <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                <button className={cx(shared.btn, shared["btn-primary"])} onClick={onClose}>Done</button>
            </div>
        </Modal>
    );
}

/**
 * The three editable fields, shared by the add and edit modals.
 *
 * One definition rather than two, so the App-scoping explanation — the part that
 * actually tells an admin what linking does to the `groups` claim — cannot drift
 * between creating a client and correcting one.
 */
function ClientFields({ name, setName, redirectUris, setRedirectUris, appId, setAppId, apps }: {
    name: string;
    setName(v: string): void;
    redirectUris: string;
    setRedirectUris(v: string): void;
    appId: string;
    setAppId(v: string): void;
    apps: App[];
}) {
    return (
        <>
            <label className={shared["login-field"]}>
                <span>Name</span>
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className={shared["login-field"]}>
                <span>Redirect URIs (one per line, optional for now)</span>
                <textarea
                    rows={3}
                    value={redirectUris}
                    onChange={(e) => setRedirectUris(e.target.value)}
                    placeholder="https://app.example.com/callback"
                />
                <span className={shared.dim} style={{ fontSize: 12 }}>
                    Matched against the authorization request exactly — scheme, host, path and
                    all. The app decides this value, so it is usually something like
                    <code> /sso/callback</code> on the app&apos;s own hostname. Leave it empty if
                    the app only shows its callback once the provider side is set up, then come
                    back and add it — nothing can sign in until you do.
                </span>
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
        </>
    );
}

function AddClientModal({ apps, provider, onClose, onCreated }: { apps: App[]; provider: OidcProviderInfo | null; onClose: () => void; onCreated: (client: OidcClient) => void }) {
    const [name, setName] = useState("");
    const [redirectUris, setRedirectUris] = useState("");
    const [appId, setAppId] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [created, setCreated] = useState<{ client: OidcClient; clientSecret: string } | null>(null);

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

    if (created) {
        return <ClientConfigModal title="Client created — configure the app" client={created.client} clientSecret={created.clientSecret} provider={provider} apps={apps} onClose={onClose} />;
    }

    return (
        <Modal title="Add OIDC client" onClose={onClose} width={480}>
            <form onSubmit={handleSubmit}>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <ClientFields
                    name={name} setName={setName}
                    redirectUris={redirectUris} setRedirectUris={setRedirectUris}
                    appId={appId} setAppId={setAppId}
                    apps={apps}
                />
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

/**
 * Correct an existing registration without reissuing its credential.
 *
 * The redirect URI is the field this exists for: it belongs to the app being
 * registered, not to Central, so it is routinely a placeholder until that app is
 * actually deployed. Deleting and re-registering to fix one would mint a new
 * client id and a new secret, which means reconfiguring the app to correct a
 * value that was only ever a typo.
 */
function EditClientModal({ client, apps, onClose, onSaved }: {
    client: OidcClient;
    apps: App[];
    onClose: () => void;
    onSaved: () => void;
}) {
    const [name, setName] = useState(client.name);
    const [redirectUris, setRedirectUris] = useState(client.redirectUris.join("\n"));
    const [appId, setAppId] = useState(client.appId ?? "");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            await api("oidc", "updateClient", {
                client: {
                    ...client,
                    name,
                    redirectUris: redirectUris.split("\n").map((s) => s.trim()).filter(Boolean),
                    appId: appId || null,
                },
            });
            onSaved();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title={`Edit ${client.name}`} onClose={onClose} width={480}>
            <form onSubmit={handleSubmit}>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <label className={shared["login-field"]}>
                    <span>Client ID</span>
                    {/* Shown but not editable: the app is configured with it, and
                        the credential surviving the edit is the point. */}
                    <input readOnly value={client.id} />
                </label>
                <ClientFields
                    name={name} setName={setName}
                    redirectUris={redirectUris} setRedirectUris={setRedirectUris}
                    appId={appId} setAppId={setAppId}
                    apps={apps}
                />
                <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                    <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                    <button className={cx(shared.btn, shared["btn-primary"])} type="submit" disabled={busy}>
                        {busy ? "Saving…" : "Save"}
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
    const [editing, setEditing] = useState<OidcClient | null>(null);
    const [rotated, setRotated] = useState<{ client: OidcClient; clientSecret: string } | null>(null);
    const [showing, setShowing] = useState<OidcClient | null>(null);
    // undefined = not loaded yet; null = no Primary URL, so no issuer to show.
    const [provider, setProvider] = useState<OidcProviderInfo | null | undefined>(undefined);

    function refresh() {
        api("oidc", "listClients", undefined).then(setClients).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }

    useEffect(refresh, []);
    useEffect(() => { api("oidc", "getProviderInfo", undefined).then(setProvider).catch(() => setProvider(null)); }, []);
    // Registered apps drive the link dropdown; an empty list just means every
    // client stays unscoped, so a failure here is not worth an error banner.
    useEffect(() => { api("apps", "list", undefined).then(setApps).catch(() => setApps([])); }, []);

    async function handleRegenerate(client: OidcClient) {
        if (!confirm(`Issue a new secret for "${client.name}"? The current one stops working immediately, and the app cannot sign anyone in until its config is updated.`)) {
            return;
        }
        setBusyId(client.id);
        setError(null);
        try {
            const { clientSecret } = await api("oidc", "regenerateSecret", { clientId: client.id });
            setRotated({ client, clientSecret });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyId(null);
        }
    }

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

            {/* The provider half of every SSO setup, up front: some apps ask for
                the issuer before they reveal the callback URL a client needs. */}
            <section className={shared.panel} style={{ marginBottom: 16, maxWidth: 720 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, margin: "0 0 4px" }}>Provider details</h2>
                <p style={{ margin: "0 0 12px", color: colorVars.muted, fontSize: 13 }}>
                    What to enter on the other app's side, independent of which client it uses.
                    Client-specific values — id, secret, the role names it will see — are under
                    each client's <strong>Config</strong>.
                </p>
                {provider === undefined ? (
                    <span className={shared.dim}>Loading…</span>
                ) : provider === null ? (
                    <span className={shared.dim}>
                        Set a <strong>Primary URL</strong> under Settings → General first — every
                        URL here hangs off it, and clients cannot be registered without one.
                    </span>
                ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <ProviderFields provider={provider} />
                    </div>
                )}
            </section>

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
                                    <td className={shared.dim}>
                                        {c.redirectUris.length > 0
                                            ? c.redirectUris.join(", ")
                                            : <span className={cx(shared.badge, shared["badge-warn"])} title="Sign-in fails until the app's callback URL is added">No redirect URI yet</span>}
                                    </td>
                                    <td className={shared.dim}>
                                        {appLabel(c, apps)}
                                    </td>
                                    <td className={shared.dim}>{new Date(c.createdAt).toLocaleString()}</td>
                                    <td className={shared["row-actions-always"]}>
                                        <button className={shared.btn} disabled={busyId === c.id} onClick={() => setShowing(c)}>
                                            Config
                                        </button>
                                        <button className={shared.btn} disabled={busyId === c.id} onClick={() => setEditing(c)}>
                                            Edit
                                        </button>
                                        <button className={shared.btn} disabled={busyId === c.id} onClick={() => void handleRegenerate(c)}>
                                            New secret
                                        </button>
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

            {rotated && (
                <ClientConfigModal
                    title="New client secret"
                    client={rotated.client}
                    clientSecret={rotated.clientSecret}
                    provider={provider ?? null}
                    apps={apps}
                    onClose={() => setRotated(null)}
                />
            )}

            {showing && (
                <ClientConfigModal
                    title={`Configure ${showing.name}`}
                    client={showing}
                    provider={provider ?? null}
                    apps={apps}
                    onClose={() => setShowing(null)}
                />
            )}

            {editing && (
                <EditClientModal
                    client={editing}
                    apps={apps}
                    onClose={() => setEditing(null)}
                    onSaved={refresh}
                />
            )}

            {adding && (
                <AddClientModal
                    apps={apps}
                    provider={provider ?? null}
                    onClose={() => setAdding(false)}
                    onCreated={(client) => setClients((prev) => [...(prev ?? []), client])}
                />
            )}
        </div>
    );
}
