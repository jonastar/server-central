import { useEffect, useState } from "react";
import type { App } from "@central/shared";
import { api } from "../../api";
import { EmptyState, ErrorBanner, Modal } from "../ui";
import { cx } from "../../utils";
import shared from "../../styles/shared.module.css";
import { colorVars } from "../../styles/colorVars";

// The App registry's admin surface. An App here is identity plus declared role
// names — it has no runtime yet, which is why it lives in Settings rather than
// as a top-level section. Apps v1 (doc/idea_app_system.md) adds stacks, volumes
// and controls to this same record, and graduates it to its own nav item.

/** Add-and-remove list for the app's declared role names. Each entry becomes
 *  `app.<slug>.<role>`, so the preview shows the node it will produce. */
function RoleList({ slug, roles, onChange }: { slug: string; roles: string[]; onChange: (next: string[]) => void }) {
    const [draft, setDraft] = useState("");

    function add() {
        const role = draft.trim().toLowerCase();
        if (role && !roles.includes(role)) {
            onChange([...roles, role]);
        }
        setDraft("");
    }

    return (
        <div>
            {roles.length > 0 && (
                <ul style={{ listStyle: "none", margin: "0 0 8px", padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                    {roles.map((role) => (
                        <li key={role} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span className={cx(shared.mono, shared.dim)} style={{ flex: 1 }}>app.{slug || "<id>"}.{role}</span>
                            <button
                                type="button"
                                className={cx(shared.btn, shared["btn-sm"])}
                                onClick={() => onChange(roles.filter((r) => r !== role))}
                            >
                                Remove
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <div style={{ display: "flex", gap: 8 }}>
                <input
                    className={shared.mono}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    // Enter would otherwise submit the surrounding form.
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
                    placeholder="admin"
                    style={{ flex: 1 }}
                />
                <button type="button" className={shared.btn} onClick={add} disabled={!draft.trim()}>Add role</button>
            </div>
        </div>
    );
}

function AppModal({ existing, onClose, onSaved }: { existing: App | null; onClose: () => void; onSaved: () => void }) {
    const [name, setName] = useState(existing?.name ?? "");
    const [slug, setSlug] = useState(existing?.slug ?? "");
    const [roles, setRoles] = useState<string[]>(existing?.roles ?? []);
    const [requireRole, setRequireRole] = useState(existing?.requireRole ?? false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // Only while creating: once an App has a slug, other records reference it.
    const [slugTouched, setSlugTouched] = useState(existing !== null);

    function handleName(value: string) {
        setName(value);
        if (!slugTouched) {
            setSlug(value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""));
        }
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            if (existing) {
                await api("apps", "update", { app: { ...existing, name, slug, roles, requireRole } });
            } else {
                await api("apps", "create", { name, slug, roles, requireRole });
            }
            onSaved();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title={existing ? `Edit ${existing.name}` : "Add app"} onClose={onClose} width={480}>
            <form onSubmit={handleSubmit}>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <label className={shared["login-field"]}>
                    <span>Name</span>
                    <input autoFocus value={name} onChange={(e) => handleName(e.target.value)} placeholder="Immich" />
                </label>
                <label className={shared["login-field"]}>
                    <span>Id</span>
                    <input
                        className={shared.mono}
                        value={slug}
                        onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }}
                        placeholder="immich"
                    />
                    <span className={shared.dim} style={{ fontSize: 12 }}>
                        Names this app's permissions: <code>app.{slug || "<id>"}.*</code>. Changing it on an app
                        that already has grants leaves those grants pointing at the old name.
                    </span>
                </label>
                <label className={shared["login-field"]}>
                    <span>Roles</span>
                    <RoleList slug={slug} roles={roles} onChange={setRoles} />
                    <span className={shared.dim} style={{ fontSize: 12 }}>
                        The role names this app itself understands — Server Central never interprets them, it
                        only passes them on. Declaring them here is what lets other screens offer a list instead
                        of a free-text box you can typo.
                    </span>
                </label>
                <label className={shared["login-field"]}>
                    <span>Access</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <input
                            type="checkbox"
                            checked={requireRole}
                            onChange={(e) => setRequireRole(e.target.checked)}
                            style={{ width: "auto", margin: 0 }}
                        />
                        <span>Require at least one role to sign in</span>
                    </span>
                    <span className={shared.dim} style={{ fontSize: 12 }}>
                        {requireRole
                            ? <>An account holding no <code>app.{slug || "<id>"}.*</code> role is refused at sign-in, rather than being handed to the app with an empty role list for it to interpret — usually as "create a new account".</>
                            : <>Any account that can sign in to Server Central can sign in to this app, and the app decides what someone with no roles may do. Leave this off for apps where everyone should get a basic account.</>}
                    </span>
                </label>
                <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                    <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                    <button className={cx(shared.btn, shared["btn-primary"])} type="submit" disabled={busy || !name || !slug}>
                        {busy ? "Saving…" : existing ? "Save" : "Create"}
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
    const [editing, setEditing] = useState<App | null>(null);
    const [adding, setAdding] = useState(false);

    function refresh() {
        api("apps", "list", undefined).then(setApps).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }

    useEffect(refresh, []);

    async function handleDelete(app: App) {
        if (!confirm(`Delete "${app.name}"? Permissions already granted as app.${app.slug}.* stay on their accounts.`)) {
            return;
        }
        setBusyId(app.id);
        setError(null);
        try {
            await api("apps", "delete", { appId: app.id });
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

            <p style={{ marginTop: 0, color: colorVars.muted, maxWidth: 640 }}>
                The apps this installation runs. Registering one gives its permissions a single definition
                (<code>app.&lt;id&gt;.*</code>) that SSO clients and account grants point at, instead of each
                place repeating the name as free text.
            </p>

            <div style={{ marginBottom: 12 }}>
                <button className={cx(shared.btn, shared["btn-primary"])} onClick={() => setAdding(true)}>Add app</button>
            </div>

            {apps === null ? (
                <EmptyState>Loading…</EmptyState>
            ) : apps.length === 0 ? (
                <EmptyState>No apps registered.</EmptyState>
            ) : (
                <section className={shared.panel}>
                    <table className={shared["data-table"]}>
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Permissions</th>
                                <th>Roles</th>
                                <th>Access</th>
                                <th>Created</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {apps.map((a) => (
                                <tr key={a.id}>
                                    <td className={shared["file-name"]}>{a.name}</td>
                                    <td className={cx(shared.mono, shared.dim)}>app.{a.slug}.*</td>
                                    <td>
                                        {a.roles.length === 0
                                            ? <span className={shared.dim}>none declared</span>
                                            : a.roles.map((r) => (
                                                <span key={r} className={shared.badge} style={{ marginRight: 4 }}>{r}</span>
                                            ))}
                                    </td>
                                    <td className={shared.dim}>
                                        {a.requireRole
                                            ? <span className={shared.badge}>role required</span>
                                            : <span className={shared.dim}>any account</span>}
                                    </td>
                                    <td className={shared.dim}>{new Date(a.createdAt).toLocaleString()}</td>
                                    <td className={shared["row-actions-always"]}>
                                        <button className={shared.btn} onClick={() => setEditing(a)}>Edit</button>
                                        <button className={shared.btn} disabled={busyId === a.id} onClick={() => void handleDelete(a)}>
                                            Delete
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}

            {(adding || editing) && (
                <AppModal
                    existing={editing}
                    onClose={() => { setAdding(false); setEditing(null); }}
                    onSaved={refresh}
                />
            )}
        </div>
    );
}
