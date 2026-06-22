import { Fragment, useState } from "react";
import type { ServerEntry } from "@central/shared";
import { api } from "../api";
import { cx, fmtDateTime, fmtUptime, isAgentOutdated } from "../utils";
import { StatusDot, EmptyState, ErrorBanner } from "./ui";
import { SetupWizard } from "./SetupWizard";

function modeBadge(mode: string | undefined) {
    if (!mode) {
        return <span className="dim">—</span>;
    }
    const cls = mode === "live" ? "badge-warn" : "badge-ok";
    return <span className={cx("badge", cls)}>{mode}</span>;
}

export function AgentsView({ servers, onOpenServer }: {
    servers: ServerEntry[];
    onOpenServer: (serverId: string) => void;
}) {
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [installEntry, setInstallEntry] = useState<ServerEntry | null>(null);

    async function update(serverId: string) {
        if (!confirm("Update this agent to the latest version? It will download the new binary and restart.")) {
            return;
        }
        setBusyId(serverId);
        setError(null);
        try {
            await api("updateNodeService", { serverId });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyId(null);
        }
    }

    async function remove(entry: ServerEntry) {
        if (!confirm(`Forget "${entry.name}"? It will reappear if the agent reconnects.`)) {
            return;
        }
        setBusyId(entry.id);
        setError(null);
        try {
            await api("deleteServer", { serverId: entry.id });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyId(null);
        }
    }

    // Stable, useful order: online first, then by name.
    const rows = [...servers].sort((a, b) => {
        const ao = a.status.state === "online" ? 0 : 1;
        const bo = b.status.state === "online" ? 0 : 1;
        return ao - bo || a.name.localeCompare(b.name);
    });

    return (
        <div className="view">
            <header className="view-header">
                <h1>Agents</h1>
            </header>

            {error && <ErrorBanner>{error}</ErrorBanner>}

            {rows.length === 0 ? (
                <EmptyState>No agents known yet.</EmptyState>
            ) : (
                <section className="panel">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>State</th>
                                <th>Name</th>
                                <th>Mode</th>
                                <th>Version</th>
                                <th>IP</th>
                                <th>OS</th>
                                <th>Uptime</th>
                                <th>Machine ID</th>
                                <th>Last seen</th>
                                <th />
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((entry) => {
                                const { status } = entry;
                                const info = status.info;
                                const online = status.state === "online";
                                const uptime = online && info
                                    ? info.uptimeSeconds + (Date.now() - info.capturedAt) / 1000
                                    : null;
                                const outdated = isAgentOutdated(entry);
                                return (
                                    <Fragment key={entry.id}>
                                        <tr className="row-clickable" onClick={() => onOpenServer(entry.id)}>
                                            <td>
                                                <StatusDot state={status.state} title={status.error ?? status.state} />
                                            </td>
                                            <td className="file-name">{entry.name}</td>
                                            <td>{modeBadge(status.mode)}</td>
                                            <td className={cx("dim", outdated && "badge-warn")} title={outdated ? "Update available" : undefined}>
                                                {info?.agentVersion ?? "—"}{outdated && " ⚠"}
                                            </td>
                                            <td className="dim">{info?.primaryIp ?? "—"}</td>
                                            <td className="dim cmd-cell" title={info?.os}>{info?.os ?? "—"}</td>
                                            <td className="dim">{uptime ? fmtUptime(uptime) : "—"}</td>
                                            <td className="mono dim" title={entry.id}>{entry.id.slice(0, 12)}</td>
                                            <td className="dim">{online ? "now" : status.lastSeenAt ? fmtDateTime(status.lastSeenAt) : "—"}</td>
                                            <td className="row-actions-always" onClick={(e) => e.stopPropagation()}>
                                                {online && status.mode === "live" && (
                                                    <button
                                                        className="btn btn-primary"
                                                        onClick={() => setInstallEntry(entry)}
                                                        title="Promote this live agent to a permanent service"
                                                    >
                                                        Complete setup
                                                    </button>
                                                )}
                                                {outdated && (
                                                    <button
                                                        className="btn"
                                                        disabled={busyId === entry.id}
                                                        onClick={() => void update(entry.id)}
                                                        title="Download the latest binary and restart the agent"
                                                    >
                                                        {busyId === entry.id ? "Updating…" : "Update"}
                                                    </button>
                                                )}
                                                {!online && (
                                                    <button
                                                        className="btn"
                                                        disabled={busyId === entry.id}
                                                        onClick={() => void remove(entry)}
                                                        title="Forget this offline agent"
                                                    >
                                                        Delete
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                        {status.standbys?.map((sb, i) => (
                                            <tr key={`${entry.id}-sb-${i}`} className="dim">
                                                <td><span className="badge badge-warn">standby</span></td>
                                                <td className="file-name">{sb.name}</td>
                                                <td>{modeBadge(sb.mode)}</td>
                                                <td>{sb.agentVersion ?? "—"}</td>
                                                <td>—</td>
                                                <td>—</td>
                                                <td>—</td>
                                                <td className="mono" title={entry.id}>{entry.id.slice(0, 12)}</td>
                                                <td>now</td>
                                                <td />
                                            </tr>
                                        ))}
                                    </Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                </section>
            )}

            {installEntry && (
                <SetupWizard entry={installEntry} onClose={() => setInstallEntry(null)} />
            )}
        </div>
    );
}
