import { useCallback, useEffect, useState } from "react";
import type { ComposeStack, ComposeStackStatus, DockerStack, HostComposeStacks, ServerEntry, StackAction } from "@central/shared";
import { api, runTaskAndWait } from "../../api";
import { cx } from "../../utils";
import { EmptyState, ErrorBanner, ExperimentalBanner } from "../ui";
import { NewComposeStackModal } from "../NewComposeStackModal";
import { ImportComposeStackModal } from "../ImportComposeStackModal";
import { DeleteComposeStackModal } from "../DeleteComposeStackModal";
import styles from "./DockerStacks.module.css";
import shared from "../../styles/shared.module.css";

const REFRESH_MS = 10_000;

const STATUS_BADGE: Record<ComposeStackStatus["status"], "badge-ok" | "badge-warn" | "badge-muted"> = {
    running: "badge-ok",
    partial: "badge-warn",
    stopped: "badge-muted",
    down: "badge-muted",
};

/**
 * One row of the merged list. A stack is *registered* when SC has a record for
 * it, and *observed* when containers carrying its compose project label exist on
 * the host right now.
 *
 * Registered-and-not-observed is a stack that's simply down. The reverse is now
 * rare: `listHostComposeStacks` adopts anything it sees running, so a row
 * without a record means adoption had nothing to point at — containers whose
 * labels carry no usable compose-file path. Those still list, they just have no
 * detail page.
 */
interface Row {
    project: string;
    label: string;
    registered?: ComposeStack;
    status?: ComposeStackStatus;
    observed?: DockerStack;
}

function observedBadge(stack: DockerStack): "badge-ok" | "badge-err" | "badge-warn" {
    if (stack.running === stack.containers) {
        return "badge-ok";
    }
    if (stack.running === 0) {
        return "badge-err";
    }
    return "badge-warn";
}

export function DockerStacks({ serverId, servers, onViewContainers, onOpenStack }: {
    serverId: string;
    servers: ServerEntry[];
    onViewContainers: (project: string) => void;
    onOpenStack: (stackId: string) => void;
}) {
    const [state, setState] = useState<HostComposeStacks | null>(null);
    const [statuses, setStatuses] = useState<Record<string, ComposeStackStatus>>({});
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [importing, setImporting] = useState(false);
    const [deleting, setDeleting] = useState<ComposeStack | null>(null);

    const host = servers.find((s) => s.id === serverId);

    const load = useCallback(async () => {
        try {
            // Adopts anything running that SC didn't know about, as a side
            // effect of the read — see HostComposeStacks.
            const next = await api("listHostComposeStacks", { hostId: serverId });
            setState(next);
            setError(null);
            const entries = await Promise.all(next.stacks.map(async (s): Promise<[string, ComposeStackStatus | null]> => {
                try {
                    return [s.id, await api("getComposeStackStatus", { stackId: s.id })];
                } catch {
                    return [s.id, null];
                }
            }));
            setStatuses(Object.fromEntries(entries.filter((e): e is [string, ComposeStackStatus] => e[1] !== null)));
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [serverId]);

    useEffect(() => {
        setState(null);
        void load();
        const timer = setInterval(() => void load(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [load]);

    /** Registered stacks act through their own compose file, so they work even
     *  fully down; unregistered ones only have running containers to act on. */
    async function registeredAction(stack: ComposeStack, act: "restart" | "stop") {
        if (act === "stop" && !confirm(`Stop "${stack.name}"?`)) {
            return;
        }
        setBusy(stack.project);
        try {
            await runTaskAndWait({ kind: "docker_compose_action", stackId: stack.id, action: act }, serverId);
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    }

    async function observedAction(stack: DockerStack, act: StackAction) {
        if ((act === "stop" || act === "down") && !confirm(`${act} stack "${stack.project}"?`)) {
            return;
        }
        setBusy(stack.project);
        try {
            await runTaskAndWait({ kind: "docker_stack_action", project: stack.project, action: act }, serverId);
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    }

    if (error && !state) {
        return <ErrorBanner>{error}</ErrorBanner>;
    }
    if (state === null) {
        return <EmptyState>Loading…</EmptyState>;
    }
    if (!state.available && state.stacks.length === 0) {
        return <EmptyState>Docker is not available on this server{state.error ? `: ${state.error}` : "."}</EmptyState>;
    }

    // Merge on the compose project name — the only identifier both sides share.
    const byProject = new Map<string, Row>();
    for (const stack of state.stacks) {
        byProject.set(stack.project, { project: stack.project, label: stack.name, registered: stack, status: statuses[stack.id] });
    }
    for (const obs of state.observed) {
        const row = byProject.get(obs.project);
        if (row) {
            row.observed = obs;
        } else {
            byProject.set(obs.project, { project: obs.project, label: obs.project, observed: obs });
        }
    }
    const rows = [...byProject.values()].sort((a, b) => a.label.localeCompare(b.label));

    return (
        <section className={shared.panel}>
            <div className={shared["panel-head"]}>
                <h3>Compose stacks ({rows.length})</h3>
                <button className={cx(shared.btn, shared["btn-sm"])} onClick={() => setImporting(true)}>Import existing…</button>
                <button className={cx(shared.btn, shared["btn-sm"], shared["btn-primary"])} disabled={!host} onClick={() => setCreating(true)}>
                    New compose stack
                </button>
            </div>

            <ExperimentalBanner>
                Compose stack management is new and still settling — service detection, imports,
                and status reporting can have rough edges.
            </ExperimentalBanner>

            {error && <ErrorBanner>{error}</ErrorBanner>}

            {state.error && (
                <div className={shared.dim} style={{ fontSize: 12, marginBottom: 8 }}>
                    Live container state is unavailable ({state.error}) — showing last known registration only.
                </div>
            )}

            {rows.length === 0 ? (
                <EmptyState>No compose stacks yet — create one, or import a directory that already has a compose file.</EmptyState>
            ) : (
                <table className={shared["data-table"]}>
                    <thead>
                        <tr><th>Stack</th><th>Status</th><th>Containers</th><th>Location</th><th /></tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => {
                            const { registered: reg, observed: obs, status } = row;
                            const services = status?.services ?? [];
                            const location = reg ? reg.dir : (obs?.configFiles ?? "");
                            return (
                                <tr key={row.project} className={cx(busy === row.project && shared["row-busy"])}>
                                    <td>
                                        {reg ? (
                                            <button className={styles["link-btn"]} onClick={() => onOpenStack(reg.id)}><b>{row.label}</b></button>
                                        ) : (
                                            <button className={styles["link-btn"]} onClick={() => onViewContainers(row.project)}><b>{row.label}</b></button>
                                        )}
                                        {!reg && (
                                            <span className={cx(shared.badge, shared["badge-muted"])} style={{ marginLeft: 8 }} title="Running on this host, but its containers carry no compose-file path to register it from">
                                                no compose path
                                            </span>
                                        )}
                                    </td>
                                    <td>
                                        {reg ? (
                                            <span className={cx(shared.badge, shared[status ? STATUS_BADGE[status.status] : "badge-muted"])}>
                                                {status ? status.status : "unknown"}
                                            </span>
                                        ) : obs ? (
                                            <span className={cx(shared.badge, shared[observedBadge(obs)])}>
                                                {obs.running === obs.containers ? "running" : obs.running === 0 ? "stopped" : "partial"}
                                            </span>
                                        ) : null}
                                    </td>
                                    <td className={shared.dim}>
                                        {obs
                                            ? `${obs.running}/${obs.containers} · ${obs.states.join(", ")}`
                                            : reg
                                                ? `0/${services.length} · no containers`
                                                : "—"}
                                    </td>
                                    <td className={cx(shared.dim, shared.mono, shared["cmd-cell"])} title={location}>{location || "—"}</td>
                                    <td className={shared["row-actions-always"]}>
                                        {reg ? (
                                            <>
                                                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy !== null} onClick={() => void registeredAction(reg, "restart")}>Restart</button>
                                                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy !== null} onClick={() => void registeredAction(reg, "stop")}>Stop</button>
                                                <button className={cx(shared.btn, shared["btn-sm"])} onClick={() => onOpenStack(reg.id)}>Open</button>
                                                <button className={cx(shared.btn, shared["btn-sm"], shared["btn-danger"])} onClick={() => setDeleting(reg)}>Remove</button>
                                            </>
                                        ) : (
                                            <>
                                                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy !== null} onClick={() => void observedAction(obs!, "start")}>Start</button>
                                                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy !== null} onClick={() => void observedAction(obs!, "restart")}>Restart</button>
                                                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy !== null} onClick={() => void observedAction(obs!, "stop")}>Stop</button>
                                            </>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}

            {creating && host && (
                <NewComposeStackModal
                    host={host}
                    onClose={() => setCreating(false)}
                    onCreated={(stackId) => { setCreating(false); onOpenStack(stackId); }}
                />
            )}
            {importing && host && (
                <ImportComposeStackModal
                    host={host}
                    onClose={() => setImporting(false)}
                    onImported={(stackId) => { setImporting(false); onOpenStack(stackId); }}
                />
            )}
            {deleting && (
                <DeleteComposeStackModal
                    stack={deleting}
                    host={host}
                    running={(state.observed.find((o) => o.project === deleting.project)?.containers ?? 0) > 0}
                    onClose={() => setDeleting(null)}
                    onDeleted={() => { setDeleting(null); void load(); }}
                />
            )}
        </section>
    );
}
