import { Fragment, useEffect, useState } from "react";
import type { AssignableRole, Role, UserDetail, UserInfo } from "@central/shared";
import { api } from "../../api";
import { cx } from "../../utils";
import { DetailPair, EmptyState, ErrorBanner, Modal } from "../ui";

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
                <label className="login-field">
                    <span>Username</span>
                    <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
                </label>
                <label className="login-field">
                    <span>Password</span>
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </label>
                <label className="login-field">
                    <span>Role</span>
                    <select className="input" value={role} onChange={(e) => setRole(e.target.value as AssignableRole)}>
                        {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
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
                className="input"
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ width: 160 }}
            />
            <input
                type="password"
                className="input"
                placeholder="Confirm"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                style={{ width: 160 }}
            />
            <button className="btn btn-sm" type="submit" disabled={busy || !password}>
                {busy ? "Setting…" : "Set password"}
            </button>
            {done && <span className="dim" style={{ fontSize: 12 }}>Password updated — their other sessions were signed out.</span>}
            {error && <span className="dim" style={{ fontSize: 12, color: "var(--err)" }}>{error}</span>}
        </form>
    );
}

function UserDetailBody({ user }: { user: UserInfo }) {
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
        <div className="row-detail">
            {error && <ErrorBanner>{error}</ErrorBanner>}
            {!detail ? (
                <EmptyState>Loading…</EmptyState>
            ) : (
                <div className="row-detail-body">
                    <div className="row-detail-meta">
                        <DetailPair label="Last active">
                            {detail.lastActiveAt ? new Date(detail.lastActiveAt).toLocaleString() : "Never"}
                        </DetailPair>
                        <DetailPair label="Sessions">{detail.sessions.length}</DetailPair>
                    </div>

                    {detail.sessions.length > 0 && (
                        <table className="data-table" style={{ marginTop: 8 }}>
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
                                        <td className="dim">{new Date(s.createdAt).toLocaleString()}</td>
                                        <td className="dim">{new Date(s.lastSeenAt).toLocaleString()}</td>
                                        <td className="mono dim">{s.ip ?? "—"}</td>
                                        <td className="dim" title={s.userAgent ?? undefined}>{formatUserAgent(s.userAgent)}</td>
                                        <td className="row-actions-always">
                                            {s.current ? (
                                                <span className="badge">this session</span>
                                            ) : (
                                                <button
                                                    className="btn btn-sm"
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
                        <div className="detail-label" style={{ marginBottom: 4 }}>Change password</div>
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
                <button className="btn btn-primary" onClick={() => setAdding(true)}>Add user</button>
            </div>

            {users === null ? (
                <EmptyState>Loading…</EmptyState>
            ) : users.length === 0 ? (
                <EmptyState>No users.</EmptyState>
            ) : (
                <section className="panel">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th className="col-expander" />
                                <th>Username</th>
                                <th>Role</th>
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
                                            className={cx("row-clickable", expanded && "row-active")}
                                            onClick={() => setExpandedId(expanded ? null : u.id)}
                                        >
                                            <td className="col-expander"><span className={cx("row-expander", expanded && "open")}>▸</span></td>
                                            <td className="file-name">{u.username}</td>
                                            <td onClick={(e) => e.stopPropagation()}>
                                                {u.role === "owner" ? (
                                                    <span className="badge">owner</span>
                                                ) : (
                                                    <select
                                                        className="input"
                                                        value={u.role}
                                                        disabled={busyId === u.id}
                                                        onChange={(e) => handleRoleChange(u.id, e.target.value as Role)}
                                                    >
                                                        {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                                                    </select>
                                                )}
                                            </td>
                                            <td className="dim">{new Date(u.createdAt).toLocaleString()}</td>
                                            <td className="row-actions-always" onClick={(e) => e.stopPropagation()}>
                                                {u.role !== "owner" && (
                                                    <button className="btn" disabled={busyId === u.id} onClick={() => void handleDelete(u)}>
                                                        Delete
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                        {expanded && (
                                            <tr className="row-detail-tr">
                                                <td />
                                                <td colSpan={4}>
                                                    <div className="row-detail-wrap">
                                                        <UserDetailBody user={u} />
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
