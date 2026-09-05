import { useEffect, useState } from "react";
import type { Permission, RoleDef } from "@central/shared";
import { PANEL_PERMISSION_IDS, SEED_ROLES, escalationsIn, permissionDef, roleMatchesSeed, seedRoleFor, unassignedPermissions } from "@central/shared";
import { api } from "../../api";
import { cx } from "../../utils";
import { EmptyState, ErrorBanner, Modal } from "../ui";
import shared from "../../styles/shared.module.css";
import { colorVars } from "../../styles/colorVars";

/**
 * The permission tree, as checkboxes grouped by namespace.
 *
 * This is the one place a tree works: a role holds `panel.*` nodes, and those
 * are a closed, documented set. (A *user's* ad-hoc grants can't be a tree —
 * `app.*` role names aren't ours to enumerate — which is why that editor stays
 * free text.) Descriptions come from the same registry the server enforces
 * with, so the list can't drift from what a grant actually does.
 */
function PermissionTree({ selected, onChange }: { selected: Permission[]; onChange: (next: Permission[]) => void }) {
    const [query, setQuery] = useState("");

    // Matches the id, the label and the description — the description matters
    // because people search for the capability ("restart") rather than the node
    // name they don't know yet.
    const needle = query.trim().toLowerCase();
    const matches = PANEL_PERMISSION_IDS.filter((id) => {
        if (!needle) {
            return true;
        }
        const def = permissionDef(id);
        return `${id} ${def.label} ${def.description}`.toLowerCase().includes(needle);
    });

    const groups = new Map<string, typeof PANEL_PERMISSION_IDS>();
    for (const id of matches) {
        // "panel.docker.read" → "docker"; "panel.terminal" → "general".
        const parts = id.split(".");
        const group = parts.length > 2 ? parts[1] : "general";
        groups.set(group, [...(groups.get(group) ?? []), id]);
    }

    function toggle(id: Permission) {
        onChange(selected.includes(id) ? selected.filter((p) => p !== id) : [...selected, id]);
    }

    return (
        <div>
            <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search permissions…"
                style={{ width: "100%", marginBottom: 8 }}
            />
            <div style={{ maxHeight: 420, overflowY: "auto" }}>
            {matches.length === 0 && <div className={shared.dim}>No permission matches “{query}”.</div>}
            {[...groups.entries()].map(([group, ids]) => (
                <div key={group} style={{ marginBottom: 10 }}>
                    <div className={shared.dim} style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>
                        {group}
                    </div>
                    {ids.map((id) => {
                        const def = permissionDef(id);
                        return (
                            <label key={id} style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer", padding: "2px 0" }}>
                                <input
                                    type="checkbox"
                                    checked={selected.includes(id)}
                                    onChange={() => toggle(id)}
                                    style={{ marginTop: 3 }}
                                />
                                <span>
                                    <span>{def.label}</span>
                                    <span className={cx(shared.mono, shared.dim)} style={{ fontSize: 11, marginLeft: 6 }}>{id}</span>
                                    {def.sensitive && (
                                        <span style={{ color: colorVars.warn, fontSize: 11, marginLeft: 6 }} title="No wildcard grants this — it must be selected by name">
                                            sensitive
                                        </span>
                                    )}
                                    {def.escalation && (
                                        <span style={{ color: colorVars.err, fontSize: 11, marginLeft: 6 }}>root</span>
                                    )}
                                    <span className={shared.dim} style={{ fontSize: 12, display: "block" }}>{def.description}</span>
                                    {def.escalation && (
                                        <span style={{ color: colorVars.err, fontSize: 11, display: "block" }}>
                                            ⚠ {def.escalation}
                                        </span>
                                    )}
                                </span>
                            </label>
                        );
                    })}
                </div>
            ))}
            </div>
        </div>
    );
}

/**
 * What a role adds up to, shown while it's being assembled.
 *
 * Individual marks are easy to scroll past, and "does this role hand out root"
 * is a property of the whole bundle rather than of any one line in it. Server
 * Central's agent runs as root, so more permissions imply it than people expect
 * — which is the entire reason for saying it out loud here.
 */
function EscalationSummary({ permissions }: { permissions: Permission[] }) {
    const escalations = escalationsIn(permissions);
    if (escalations.length === 0) {
        return null;
    }
    return (
        <div style={{ border: `1px solid ${colorVars.err}`, borderRadius: 4, padding: 8, marginBottom: 12, fontSize: 12 }}>
            <div style={{ color: colorVars.err }}>
                This role grants root on managed hosts, through {escalations.length} of its permissions:
            </div>
            <ul style={{ margin: "4px 0 0 16px" }}>
                {escalations.map(({ id, why }) => (
                    <li key={id} className={shared.dim}>
                        <span className={shared.mono}>{id}</span> — {why}
                    </li>
                ))}
            </ul>
        </div>
    );
}

function RoleModal({ role, onClose, onSaved }: { role: RoleDef | null; onClose: () => void; onSaved: () => void }) {
    const [name, setName] = useState(role?.name ?? "");
    const [description, setDescription] = useState(role?.description ?? "");
    const [permissions, setPermissions] = useState<Permission[]>(role ? [...role.permissions] : []);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // `app.*` grants belong on a role too — a "Photos" role granting
    // app.immich.user is the whole point of the second namespace — but they
    // can't be offered as checkboxes, so they get a text field of their own.
    const appGrants = permissions.filter((p) => !p.startsWith("panel."));
    const [appText, setAppText] = useState(appGrants.join("\n"));

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const merged = [
            ...permissions.filter((p) => p.startsWith("panel.")),
            ...appText.split("\n").map((l) => l.trim()).filter(Boolean),
        ];
        try {
            if (role) {
                await api("auth", "updateRole", { role: { ...role, name, description, permissions: merged } });
            } else {
                await api("auth", "createRole", { name, description, permissions: merged });
            }
            onSaved();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setBusy(false);
        }
    }

    return (
        <Modal title={role ? `Edit ${role.name}` : "New role"} onClose={onClose} width={620}>
            <form onSubmit={handleSubmit}>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <label className={shared["login-field"]}>
                    <span>Name</span>
                    <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Photos" />
                </label>
                <label className={shared["login-field"]}>
                    <span>Description</span>
                    <input
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="What someone holding this role can do"
                    />
                </label>

                <EscalationSummary permissions={permissions} />

                <div className={shared["login-field"]}>
                    <span>Control panel permissions ({permissions.filter((p) => p.startsWith("panel.")).length} selected)</span>
                    <PermissionTree selected={permissions} onChange={setPermissions} />
                </div>

                <label className={shared["login-field"]}>
                    <span>App permissions — one per line, e.g. <span className={shared.mono}>app.immich.user</span></span>
                    <textarea
                        value={appText}
                        onChange={(e) => setAppText(e.target.value)}
                        rows={3}
                        spellCheck={false}
                        className={shared.mono}
                        style={{ width: "100%", resize: "vertical" }}
                    />
                </label>

                <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                    <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                    <button className={cx(shared.btn, shared["btn-primary"])} type="submit" disabled={busy}>
                        {busy ? "Saving…" : role ? "Save" : "Create"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

export function RolesTab() {
    const [roles, setRoles] = useState<RoleDef[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<RoleDef | null>(null);
    const [creating, setCreating] = useState(false);

    function refresh() {
        api("auth", "listRoles", undefined).then(setRoles).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }

    useEffect(refresh, []);

    async function handleReset(role: RoleDef) {
        const seed = seedRoleFor(role.id)!;
        const added = seed.permissions.filter((p) => !role.permissions.includes(p));
        const removed = role.permissions.filter((p) => !seed.permissions.includes(p));
        // Spell out the change rather than asking to confirm an abstraction:
        // "reset" reads as harmless right up until it removes something someone
        // added on purpose.
        const summary = [
            added.length ? `add ${added.length} permission${added.length === 1 ? "" : "s"}` : null,
            removed.length ? `remove ${removed.length}` : null,
        ].filter(Boolean).join(" and ");
        if (!confirm(`Reset "${role.name}" to its default? This will ${summary || "restore its name and description"}.`)) {
            return;
        }
        setError(null);
        try {
            await api("auth", "resetRole", { roleId: role.id });
            refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    async function handleRestore(roleId: string) {
        setError(null);
        try {
            await api("auth", "resetRole", { roleId });
            refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    async function handleDelete(role: RoleDef) {
        if (!confirm(`Delete the role "${role.name}"?`)) {
            return;
        }
        setError(null);
        try {
            await api("auth", "deleteRole", { roleId: role.id });
            refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    if (!roles) {
        return <EmptyState>Loading…</EmptyState>;
    }

    // Roles are seeded once and owned by this installation from then on, so a
    // permission added in a later release lands in no role until someone puts it
    // there. That's deliberate — an update must never widen an existing role —
    // but it would otherwise be invisible, so say so here.
    const unassigned = unassignedPermissions(roles);
    // Seeded roles this installation deleted. Offered back rather than
    // re-seeded automatically: deleting one is a decision, and undoing it on the
    // next restart would be the store overruling its owner.
    const missingSeeds = SEED_ROLES.filter((seed) => !roles.some((r) => r.id === seed.id));

    return (
        <div>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            {editing && <RoleModal role={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
            {creating && <RoleModal role={null} onClose={() => setCreating(false)} onSaved={refresh} />}

            <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
                <div className={shared.dim} style={{ fontSize: 12 }}>
                    A user holds any number of roles; their permissions add together.
                </div>
                <button className={cx(shared.btn, shared["btn-primary"])} style={{ marginLeft: "auto" }} onClick={() => setCreating(true)}>
                    New role
                </button>
            </div>

            <table className={shared["data-table"]}>
                <thead>
                    <tr>
                        <th>Role</th>
                        <th>Permissions</th>
                        <th />
                    </tr>
                </thead>
                <tbody>
                    {roles.map((role) => (
                        <tr key={role.id}>
                            <td>
                                <div className={shared["file-name"]}>
                                    {role.name}
                                    {seedRoleFor(role.id) && !roleMatchesSeed(role) && (
                                        <span
                                            className={shared.badge}
                                            style={{ marginLeft: 6 }}
                                            title="Differs from the definition Server Central ships — either edited here, or a later release added a permission this role never picked up"
                                        >
                                            modified
                                        </span>
                                    )}
                                </div>
                                <div className={shared.dim} style={{ fontSize: 12 }}>{role.description}</div>
                            </td>
                            <td className={shared.dim}>
                                {role.permissions.length}
                                {escalationsIn(role.permissions).length > 0 && (
                                    <span style={{ color: colorVars.err, marginLeft: 6, fontSize: 11 }} title="Some of these grant root on managed hosts">
                                        root
                                    </span>
                                )}
                            </td>
                            <td className={shared["row-actions-always"]}>
                                <button className={shared.btn} onClick={() => setEditing(role)}>Edit</button>
                                {seedRoleFor(role.id) && !roleMatchesSeed(role) && (
                                    <button className={shared.btn} onClick={() => void handleReset(role)}>Reset to default</button>
                                )}
                                <button className={shared.btn} onClick={() => void handleDelete(role)}>Delete</button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>

            {missingSeeds.length > 0 && (
                <div style={{ marginTop: 16, fontSize: 12 }}>
                    <div className={shared.dim}>
                        {missingSeeds.length} role{missingSeeds.length === 1 ? "" : "s"} Server Central ships
                        {missingSeeds.length === 1 ? " is" : " are"} not defined here.
                    </div>
                    <ul style={{ margin: "4px 0 0 16px" }}>
                        {missingSeeds.map((seed) => (
                            <li key={seed.id} className={shared.dim} style={{ marginBottom: 2 }}>
                                {seed.name} — {seed.description}{" "}
                                <button
                                    className={cx(shared.btn, shared["btn-sm"])}
                                    onClick={() => void handleRestore(seed.id)}
                                >
                                    Restore
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {unassigned.length > 0 && (
                <div style={{ marginTop: 16, fontSize: 12 }}>
                    <div className={shared.dim}>
                        {unassigned.length} permission{unassigned.length === 1 ? " is" : "s are"} in no role.
                        Roles are never widened by an update, so anything added in a newer version starts here.
                    </div>
                    <ul className={shared.dim} style={{ margin: "4px 0 0 16px" }}>
                        {unassigned.map((id) => (
                            <li key={id}>
                                <span className={shared.mono}>{id}</span> — {permissionDef(id).label}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
