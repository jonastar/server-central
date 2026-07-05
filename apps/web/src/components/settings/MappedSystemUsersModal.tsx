import { useCallback, useEffect, useState } from "react";
import type { SystemUserHostStatus } from "@central/shared";
import { api } from "../../api";
import { EmptyState, ErrorBanner, Modal } from "../ui";

const STATUS_BADGE: Record<SystemUserHostStatus["status"], { label: string; className: string }> = {
    exists: { label: "exists", className: "badge badge-ok" },
    missing: { label: "missing", className: "badge badge-warn" },
    offline: { label: "offline", className: "badge" },
    error: { label: "error", className: "badge badge-err" },
};

/** One host row: status, account details, and the per-status action (create the
 *  account when missing, edit its supplementary groups when it exists). */
function HostRow({ systemUser, host, onChanged }: {
    systemUser: string;
    host: SystemUserHostStatus;
    onChanged: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [groupsInput, setGroupsInput] = useState("");

    const supplementary = (host.user?.groups ?? []).filter((g) => g !== host.user?.primaryGroup);

    async function run(action: () => Promise<void>) {
        setBusy(true);
        setError(null);
        try {
            await action();
            setEditing(false);
            onChanged();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    function handleCreate() {
        void run(() => api("systemUserCreate", { serverId: host.serverId, username: systemUser, groups: [] }));
    }

    function handleSaveGroups() {
        const groups = groupsInput.split(",").map((g) => g.trim()).filter(Boolean);
        void run(() => api("systemUserSetGroups", { serverId: host.serverId, username: systemUser, groups }));
    }

    const badge = STATUS_BADGE[host.status];

    return (
        <tr>
            <td><b>{host.serverName}</b></td>
            <td>
                <span className={badge.className}>{badge.label}</span>
                {host.error && <span className="dim" style={{ marginLeft: 6, fontSize: 12 }}>{host.error}</span>}
            </td>
            <td className="dim">{host.user ? host.user.uid : "—"}</td>
            <td>
                {host.status === "exists" && !editing && (
                    <span className="dim">{host.user?.groups.join(", ") || "—"}</span>
                )}
                {editing && (
                    <input
                        className="input mono"
                        autoFocus
                        value={groupsInput}
                        onChange={(e) => setGroupsInput(e.target.value)}
                        placeholder="e.g. docker, sudo"
                        style={{ width: "100%", minWidth: 140 }}
                    />
                )}
                {host.status !== "exists" && <span className="dim">—</span>}
            </td>
            <td className="mono dim">{host.user?.shell ?? "—"}</td>
            <td style={{ whiteSpace: "nowrap" }}>
                {host.status === "missing" && (
                    <button className="btn btn-sm" disabled={busy} onClick={handleCreate}>
                        {busy ? "Creating…" : "Create account"}
                    </button>
                )}
                {host.status === "exists" && !editing && (
                    <button
                        className="btn btn-sm"
                        onClick={() => {
                            setGroupsInput(supplementary.join(", "));
                            setEditing(true);
                        }}
                    >
                        Edit groups
                    </button>
                )}
                {editing && (
                    <>
                        <button className="btn btn-sm btn-primary" disabled={busy} onClick={handleSaveGroups}>
                            {busy ? "Saving…" : "Save"}
                        </button>
                        <button className="btn btn-sm" disabled={busy} onClick={() => setEditing(false)} style={{ marginLeft: 4 }}>
                            Cancel
                        </button>
                    </>
                )}
                {error && <div className="dim" style={{ fontSize: 12, color: "var(--err)" }}>{error}</div>}
            </td>
        </tr>
    );
}

/** Fleet-wide view of one mapped OS account: which hosts have it, which are
 *  missing it (create it there in one click), and its groups where it exists. */
export function MappedSystemUsersModal({ scUsername, systemUser, onClose }: {
    scUsername: string;
    systemUser: string;
    onClose: () => void;
}) {
    const [hosts, setHosts] = useState<SystemUserHostStatus[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setHosts(await api("systemUserHostStatus", { username: systemUser }));
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [systemUser]);

    useEffect(() => {
        void load();
    }, [load]);

    return (
        <Modal title={`System user "${systemUser}" — mapped for ${scUsername}`} onClose={onClose} width={720}>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            {hosts === null && !error && <EmptyState>Checking hosts…</EmptyState>}
            {hosts !== null && (
                <table className="data-table">
                    <thead>
                        <tr><th>Host</th><th>Status</th><th>UID</th><th>Groups</th><th>Shell</th><th /></tr>
                    </thead>
                    <tbody>
                        {hosts.map((h) => (
                            <HostRow key={h.serverId} systemUser={systemUser} host={h} onChanged={() => void load()} />
                        ))}
                    </tbody>
                </table>
            )}
            <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>
                "Create account" runs useradd -m with no extra groups — add groups
                afterwards. Editing groups replaces the supplementary list (primary
                group untouched); groups must already exist on that host. Careful
                with the docker group — membership is equivalent to root.
            </p>
        </Modal>
    );
}
