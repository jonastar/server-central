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

/** Roles are edited as a comma-separated list — short, ordered, and usually two
 *  entries. A chip editor would be more than this earns. */
function parseRoles(text: string): string[] {
    return text.split(",").map((r) => r.trim()).filter(Boolean);
}

function AppModal({ existing, onClose, onSaved }: { existing: App | null; onClose: () => void; onSaved: () => void }) {
    const [name, setName] = useState(existing?.name ?? "");
    const [slug, setSlug] = useState(existing?.slug ?? "");
    const [roles, setRoles] = useState((existing?.roles ?? []).join(", "));
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
                await api("apps", "update", { app: { ...existing, name, slug, roles: parseRoles(roles) } });
            } else {
                await api("apps", "create", { name, slug, roles: parseRoles(roles) });
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
                    <span>Roles (comma separated)</span>
                    <input className={shared.mono} value={roles} onChange={(e) => setRoles(e.target.value)} placeholder="user, admin" />
                    <span className={shared.dim} style={{ fontSize: 12 }}>
                        The role names this app itself understands — Server Central never interprets them, it
                        only passes them on. Declaring them here is what lets other screens offer a list instead
                        of a free-text box you can typo.
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
