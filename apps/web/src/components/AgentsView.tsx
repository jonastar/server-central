import { Fragment, useState } from "react";
import type { ServerEntry } from "@central/shared";
import { api } from "../api";
import { runTaskAndWait } from "../taskRun";
import { cx, fmtDateTime, fmtUptime, isAgentOutdated } from "../utils";
import { StatusDot, EmptyState, ErrorBanner } from "./ui";
import { SetupWizard } from "./SetupWizard";
import shared from "../styles/shared.module.css";

function modeBadge(mode: string | undefined) {
    if (!mode) {
        return <span className={shared.dim}>—</span>;
    }
    const cls: "badge-warn" | "badge-ok" = mode === "live" ? "badge-warn" : "badge-ok";
    return <span className={cx(shared.badge, shared[cls])}>{mode}</span>;
}

export function AgentsView({ servers, onOpenServer }: {
    servers: ServerEntry[];
    onOpenServer: (serverId: string) => void;
}) {
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [installEntry, setInstallEntry] = useState<ServerEntry | null>(null);

    async function update(serverId: string, force: boolean) {
        const prompt = force
            ? "Reinstall the control plane's current build on this agent even though it reports the same version? It will download the binary and restart."
            : "Update this agent to the latest version? It will download the new binary and restart.";
        if (!confirm(prompt)) {
            return;
        }
        setBusyId(serverId);
        setError(null);
        try {
            await runTaskAndWait({ kind: "update_agent", force }, serverId, { feedback: "modal" });
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
            await api("servers", "delete", { serverId: entry.id });
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
        <div className={shared.view}>
            <header className={shared["view-header"]}>
                <h1>Agents</h1>
            </header>

            {error && <ErrorBanner>{error}</ErrorBanner>}

            {rows.length === 0 ? (
                <EmptyState>No agents known yet.</EmptyState>
            ) : (
                <section className={shared.panel}>
                    <table className={shared["data-table"]}>
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
                                        <tr className={shared["row-clickable"]} onClick={() => onOpenServer(entry.id)}>
                                            <td>
                                                <StatusDot state={status.state} title={status.error ?? status.state} />
                                            </td>
                                            <td className={shared["file-name"]}>{entry.name}</td>
                                            <td>{modeBadge(status.mode)}</td>
                                            <td className={cx(shared.dim, outdated && shared["badge-warn"])} title={outdated ? "Update available" : undefined}>
                                                {info?.agentVersion ?? "—"}{outdated && " ⚠"}
                                            </td>
                                            <td className={shared.dim}>{info?.primaryIp ?? "—"}</td>
                                            <td className={cx(shared.dim, shared["cmd-cell"])} title={info?.os}>{info?.os ?? "—"}</td>
                                            <td className={shared.dim}>{uptime ? fmtUptime(uptime) : "—"}</td>
                                            <td className={cx(shared.mono, shared.dim)} title={entry.id}>{entry.id.slice(0, 12)}</td>
                                            <td className={shared.dim}>{online ? "now" : status.lastSeenAt ? fmtDateTime(status.lastSeenAt) : "—"}</td>
                                            <td className={shared["row-actions-always"]} onClick={(e) => e.stopPropagation()}>
                                                {online && status.mode === "live" && (
                                                    <button
                                                        className={cx(shared.btn, shared["btn-primary"])}
                                                        onClick={() => setInstallEntry(entry)}
                                                        title="Promote this live agent to a permanent service"
                                                    >
                                                        Complete setup
                                                    </button>
                                                )}
                                                {online && status.mode === "installed" && (
                                                    <button
                                                        className={shared.btn}
                                                        disabled={busyId === entry.id}
                                                        onClick={() => void update(entry.id, !outdated)}
                                                        title={outdated
                                                            ? "Download the latest binary and restart the agent"
                                                            : "Reinstall the current build even though the version matches (dev rebuilds)"}
                                                    >
                                                        {busyId === entry.id ? "Updating…" : outdated ? "Update" : "Force update"}
                                                    </button>
                                                )}
                                                {!online && (
                                                    <button
                                                        className={shared.btn}
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
                                            <tr key={`${entry.id}-sb-${i}`} className={shared.dim}>
                                                <td><span className={cx(shared.badge, shared["badge-warn"])}>standby</span></td>
                                                <td className={shared["file-name"]}>{sb.name}</td>
                                                <td>{modeBadge(sb.mode)}</td>
                                                <td>{sb.agentVersion ?? "—"}</td>
                                                <td>—</td>
                                                <td>—</td>
                                                <td>—</td>
                                                <td className={shared.mono} title={entry.id}>{entry.id.slice(0, 12)}</td>
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
