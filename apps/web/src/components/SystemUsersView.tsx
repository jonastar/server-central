import { useCallback, useEffect, useState } from "react";
import type { SystemUsersState } from "@central/shared";
import { api } from "../api";
import { cx } from "../utils";
import { EmptyState, ErrorBanner, Modal } from "./ui";
import shared from "../styles/shared.module.css";

function AddSystemUserModal({ serverId, onClose, onCreated }: { serverId: string; onClose: () => void; onCreated: () => void }) {
    const [username, setUsername] = useState("");
    const [groups, setGroups] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            const groupList = groups.split(",").map((g) => g.trim()).filter(Boolean);
            await api("system-users", "create", { serverId, username: username.trim(), groups: groupList });
            onCreated();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="Add system user" onClose={onClose} width={420}>
            <form onSubmit={handleSubmit}>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <label className={shared["login-field"]}>
                    <span>Username</span>
                    <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. deploy" />
                </label>
                <label className={shared["login-field"]}>
                    <span>Groups (comma-separated, must already exist)</span>
                    <input value={groups} onChange={(e) => setGroups(e.target.value)} placeholder="e.g. docker, sudo" />
                </label>
                <p className={shared.dim} style={{ fontSize: 12, marginTop: 8 }}>
                    Creates the account with a home directory (useradd -m). Careful with
                    the docker group — membership is equivalent to root.
                </p>
                <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                    <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                    <button className={cx(shared.btn, shared["btn-primary"])} type="submit" disabled={busy || !username.trim()}>
                        {busy ? "Creating…" : "Create"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

export function SystemUsersView({ serverId }: { serverId: string }) {
    const [state, setState] = useState<SystemUsersState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState("");
    const [adding, setAdding] = useState(false);

    const load = useCallback(async () => {
        try {
            setState(await api("system-users", "list", { serverId }));
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [serverId]);

    useEffect(() => {
        setState(null);
        void load();
    }, [load]);

    const shown = (state?.users ?? [])
        .filter((u) => !filter || u.username.toLowerCase().includes(filter.toLowerCase()) || u.groups.some((g) => g.toLowerCase().includes(filter.toLowerCase())));

    return (
        <div className={shared.view}>
            <header className={shared["view-header"]}>
                <h1>Users</h1>
            </header>

            {error && <ErrorBanner>{error}</ErrorBanner>}
            {state === null && !error && <EmptyState>Loading…</EmptyState>}
            {state && !state.available && (
                <EmptyState>Can't list system users on this server{state.error ? `: ${state.error}` : "."}</EmptyState>
            )}

            {state?.available && (
                <section className={shared.panel}>
                    <div className={shared["panel-head"]}>
                        <h3>System users ({shown.length})</h3>
                        <input
                            className={shared["filter-input"]}
                            placeholder="Filter by name or group…"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                        />
                        <button className={shared.btn} onClick={() => setAdding(true)}>Add user</button>
                        <button className={shared.btn} onClick={() => void load()}>Refresh</button>
                    </div>
                    {shown.length === 0 ? (
                        <EmptyState>No matching users.</EmptyState>
                    ) : (
                        <table className={shared["data-table"]}>
                            <thead>
                                <tr><th>Username</th><th>UID</th><th>Groups</th><th>Home</th><th>Shell</th><th>Mapped accounts</th></tr>
                            </thead>
                            <tbody>
                                {shown.map((u) => (
                                    <tr key={u.username} className={cx(u.uid === 0 && shared["row-status-warn"])}>
                                        <td>
                                            <b>{u.username}</b>
                                            {u.uid === 0 && <span className={shared.badge} style={{ marginLeft: 6 }}>root</span>}
                                        </td>
                                        <td className={shared.dim}>{u.uid}</td>
                                        <td className={shared.dim}>{u.groups.join(", ") || "—"}</td>
                                        <td className={cx(shared.mono, shared.dim)}>{u.home}</td>
                                        <td className={cx(shared.mono, shared.dim)}>{u.shell}</td>
                                        <td>
                                            {u.mappedBy.length > 0
                                                ? u.mappedBy.map((name) => <span key={name} className={cx(shared.badge, shared["badge-ok"])} style={{ marginRight: 4 }}>{name}</span>)
                                                : <span className={shared.dim}>—</span>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                    <p className={shared.dim} style={{ fontSize: 12, padding: "8px 12px" }}>
                        Mapped accounts are Server Central users whose terminal runs as that
                        system user (set in Settings → Users). System/daemon accounts below
                        UID 1000 are hidden.
                    </p>
                </section>
            )}

            {adding && (
                <AddSystemUserModal serverId={serverId} onClose={() => setAdding(false)} onCreated={() => void load()} />
            )}
        </div>
    );
}
