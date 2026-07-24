import { Fragment, useEffect, useState } from "react";
import type { AssignableRole, Role, SystemUserHostStatus, UserDetail, UserInfo } from "@central/shared";
import { api } from "../../api";
import { cx } from "../../utils";
import { DetailPair, EmptyState, ErrorBanner, Modal } from "../ui";
import { MappedSystemUsersModal } from "./MappedSystemUsersModal";
import shared from "../../styles/shared.module.css";
import uiStyles from "../ui.module.css";

const ASSIGNABLE_ROLES: AssignableRole[] = ["admin", "operator", "viewer"];

function AddUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: (user: UserInfo) => void }) {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [role, setRole] = useState<AssignableRole>("viewer");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            const user = await api("createUser", { username, password, role });
            onCreated(user);
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="Add user" onClose={onClose} width={420}>
            <form onSubmit={handleSubmit}>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <label className={shared["login-field"]}>
                    <span>Username</span>
                    <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
                </label>
                <label className={shared["login-field"]}>
                    <span>Password</span>
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </label>
                <label className={shared["login-field"]}>
                    <span>Role</span>
                    <select value={role} onChange={(e) => setRole(e.target.value as AssignableRole)}>
                        {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
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

function formatUserAgent(ua: string | null): string {
    if (!ua) {
        return "—";
    }
    return ua.length > 64 ? `${ua.slice(0, 61)}…` : ua;
}

function ChangePasswordForm({ userId, onDone }: { userId: string; onDone: () => void }) {
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setDone(false);
        if (password !== confirmPassword) {
            setError("Passwords don't match");
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await api("adminSetPassword", { userId, password });
            setPassword("");
            setConfirmPassword("");
            setDone(true);
            onDone();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={handleSubmit} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input
                type="password"
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ width: 160 }}
            />
            <input
                type="password"
                placeholder="Confirm"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                style={{ width: 160 }}
            />
            <button className={cx(shared.btn, shared["btn-sm"])} type="submit" disabled={busy || !password}>
                {busy ? "Setting…" : "Set password"}
            </button>
            {done && <span className={shared.dim} style={{ fontSize: 12 }}>Password updated — their other sessions were signed out.</span>}
            {error && <span className={shared.dim} style={{ fontSize: 12, color: "var(--err)" }}>{error}</span>}
        </form>
    );
}

function SystemUserForm({ user, onSaved }: { user: UserInfo; onSaved: () => void }) {
    const [value, setValue] = useState(user.systemUser ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setDone(false);
        try {
            await api("setUserSystemUser", { userId: user.id, systemUser: value.trim() || null });
            setDone(true);
            onSaved();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={handleSubmit} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <input
                className={shared.mono}
                placeholder="none"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                style={{ width: 160 }}
            />
            <button className={cx(shared.btn, shared["btn-sm"])} type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save"}
            </button>
            <span className={shared.dim} style={{ fontSize: 12 }}>
                {done
                    ? "Saved — takes effect on the next terminal they open."
                    : "Their terminal runs as this OS account on every host. Empty = unmapped: owner/admin get root, others get no terminal."}
            </span>
            {error && <span className={shared.dim} style={{ fontSize: 12, color: "var(--err)" }}>{error}</span>}
        </form>
    );
}

/** Notice line under the mapping form: where the mapped account is missing,
 *  plus the entry point to the per-host modal (create it there, edit groups). */
function MappedHostsSummary({ user }: { user: UserInfo }) {
    const systemUser = user.systemUser;
    const [hosts, setHosts] = useState<SystemUserHostStatus[] | null>(null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        setHosts(null);
        if (!systemUser) {
            return;
        }
        api("systemUserHostStatus", { username: systemUser })
            .then(setHosts)
            .catch(() => setHosts([]));
    }, [systemUser, open]); // re-check after the modal closes — accounts may have been created

    if (!systemUser) {
        return null;
    }

    const missing = (hosts ?? []).filter((h) => h.status === "missing");
    const offline = (hosts ?? []).filter((h) => h.status === "offline");

    return (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
            {hosts === null && <span className={shared.dim} style={{ fontSize: 12 }}>Checking hosts…</span>}
            {hosts !== null && missing.length > 0 && (
                <span className={cx(shared.badge, shared["badge-warn"])}>
                    missing on {missing.map((h) => h.serverName).join(", ")}
                </span>
            )}
            {hosts !== null && missing.length === 0 && (
                <span className={shared.dim} style={{ fontSize: 12 }}>
                    Account present on all online hosts{offline.length > 0 ? ` (${offline.length} offline, unknown)` : ""}.
                </span>
            )}
            <button className={cx(shared.btn, shared["btn-sm"])} onClick={() => setOpen(true)}>Mapped hosts…</button>
            {open && (
                <MappedSystemUsersModal scUsername={user.username} systemUser={systemUser} onClose={() => setOpen(false)} />
            )}
        </div>
    );
}

function UserDetailBody({ user, onChanged }: { user: UserInfo; onChanged: () => void }) {
    const [detail, setDetail] = useState<UserDetail | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busySessionId, setBusySessionId] = useState<string | null>(null);

    function refresh() {
        api("getUserDetail", { userId: user.id }).then(setDetail).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }

    useEffect(refresh, [user.id]);

    async function handleRevoke(sessionId: string) {
        setBusySessionId(sessionId);
        setError(null);
        try {
            await api("revokeUserSession", { userId: user.id, sessionId });
            refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusySessionId(null);
        }
    }

    return (
        <div className={shared["row-detail"]}>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            {!detail ? (
                <EmptyState>Loading…</EmptyState>
            ) : (
                <div className={shared["row-detail-body"]}>
                    <div className={shared["row-detail-meta"]}>
                        <DetailPair label="Last active">
                            {detail.lastActiveAt ? new Date(detail.lastActiveAt).toLocaleString() : "Never"}
                        </DetailPair>
                        <DetailPair label="Sessions">{detail.sessions.length}</DetailPair>
                    </div>

                    {detail.sessions.length > 0 && (
                        <table className={shared["data-table"]} style={{ marginTop: 8 }}>
                            <thead>
                                <tr>
                                    <th>Created</th>
                                    <th>Last active</th>
                                    <th>IP</th>
                                    <th>Device</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {detail.sessions.map((s) => (
                                    <tr key={s.id}>
                                        <td className={shared.dim}>{new Date(s.createdAt).toLocaleString()}</td>
                                        <td className={shared.dim}>{new Date(s.lastSeenAt).toLocaleString()}</td>
                                        <td className={cx(shared.mono, shared.dim)}>{s.ip ?? "—"}</td>
                                        <td className={shared.dim} title={s.userAgent ?? undefined}>{formatUserAgent(s.userAgent)}</td>
                                        <td className={shared["row-actions-always"]}>
                                            {s.current ? (
                                                <span className={shared.badge}>this session</span>
                                            ) : (
                                                <button
                                                    className={cx(shared.btn, shared["btn-sm"])}
                                                    disabled={busySessionId === s.id}
                                                    onClick={() => void handleRevoke(s.id)}
                                                >
                                                    Revoke
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}

                    <div style={{ marginTop: 12 }}>
                        <div className={uiStyles["detail-label"]} style={{ marginBottom: 4 }}>System user</div>
                        <SystemUserForm user={user} onSaved={onChanged} />
                        <MappedHostsSummary user={user} />
                    </div>

                    <div style={{ marginTop: 12 }}>
                        <div className={uiStyles["detail-label"]} style={{ marginBottom: 4 }}>Change password</div>
                        <ChangePasswordForm userId={user.id} onDone={refresh} />
                    </div>
                </div>
            )}
        </div>
    );
}

export function UsersTab() {
    const [users, setUsers] = useState<UserInfo[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    function refresh() {
        api("listUsers", undefined).then(setUsers).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }

    useEffect(refresh, []);

    async function handleRoleChange(userId: string, role: Role) {
        if (role === "owner") {
            return;
        }
        setBusyId(userId);
        setError(null);
        try {
            await api("updateUserRole", { userId, role });
            refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyId(null);
        }
    }

    async function handleDelete(user: UserInfo) {
        if (!confirm(`Delete user "${user.username}"?`)) {
            return;
        }
        setBusyId(user.id);
        setError(null);
        try {
            await api("deleteUser", { userId: user.id });
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
                <button className={cx(shared.btn, shared["btn-primary"])} onClick={() => setAdding(true)}>Add user</button>
            </div>

            {users === null ? (
                <EmptyState>Loading…</EmptyState>
            ) : users.length === 0 ? (
                <EmptyState>No users.</EmptyState>
            ) : (
                <section className={shared.panel}>
                    <table className={shared["data-table"]}>
                        <thead>
                            <tr>
                                <th className={shared["col-expander"]} />
                                <th>Username</th>
                                <th>Role</th>
                                <th>System user</th>
                                <th>Created</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {users.map((u) => {
                                const expanded = expandedId === u.id;
                                return (
                                    <Fragment key={u.id}>
                                        <tr
                                            className={cx(shared["row-clickable"], expanded && shared["row-active"])}
                                            onClick={() => setExpandedId(expanded ? null : u.id)}
                                        >
                                            <td className={shared["col-expander"]}><span className={cx(shared["row-expander"], expanded && shared.open)}>▸</span></td>
                                            <td className={shared["file-name"]}>{u.username}</td>
                                            <td onClick={(e) => e.stopPropagation()}>
                                                {u.role === "owner" ? (
                                                    <span className={shared.badge}>owner</span>
                                                ) : (
                                                    <select
                                                        value={u.role}
                                                        disabled={busyId === u.id}
                                                        onChange={(e) => handleRoleChange(u.id, e.target.value as Role)}
                                                    >
                                                        {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                                                    </select>
                                                )}
                                            </td>
                                            <td>{u.systemUser ? <span className={shared.mono}>{u.systemUser}</span> : <span className={shared.dim}>—</span>}</td>
                                            <td className={shared.dim}>{new Date(u.createdAt).toLocaleString()}</td>
                                            <td className={shared["row-actions-always"]} onClick={(e) => e.stopPropagation()}>
                                                {u.role !== "owner" && (
                                                    <button className={shared.btn} disabled={busyId === u.id} onClick={() => void handleDelete(u)}>
                                                        Delete
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                        {expanded && (
                                            <tr className={shared["row-detail-tr"]}>
                                                <td />
                                                <td colSpan={5}>
                                                    <div className={shared["row-detail-wrap"]}>
                                                        <UserDetailBody user={u} onChanged={refresh} />
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                </section>
            )}

            {adding && (
                <AddUserModal
                    onClose={() => setAdding(false)}
                    onCreated={(user) => setUsers((prev) => [...(prev ?? []), user])}
                />
            )}
        </div>
    );
}
