import { useCallback, useEffect, useState } from "react";
import type { ComposeStack, ComposeStackRunStatus, ComposeStackStatus, DockerStack, HostComposeStacks, ServerEntry, StackAction } from "@central/shared";
import { api } from "../../api";
import { useTaskAction } from "../../hooks/useTaskAction";
import { cx } from "../../utils";
import { ActionMenu, DetailedList, DetailedRow, EmptyState, ErrorBanner, ExperimentalBanner, TaskProgress } from "../ui";
import { NewComposeStackModal } from "../NewComposeStackModal";
import { ImportComposeStackModal } from "../ImportComposeStackModal";
import { DeleteComposeStackModal } from "../DeleteComposeStackModal";
import { observedStatus, stackTone, StatusBadge } from "./status";
import styles from "./DockerStacks.module.css";
import shared from "../../styles/shared.module.css";

const REFRESH_MS = 10_000;

/** Compose verbs a *registered* stack can be driven with — it acts through its
 *  own compose file, so these work even when it's fully down. */
type ComposeVerb = "up" | "restart" | "stop" | "down";

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

/** The row's state in the shared vocabulary, whichever side it came from. */
function rowStatus(row: Row): ComposeStackRunStatus {
    if (row.registered) {
        return row.status?.status ?? (row.observed ? observedStatus(row.observed) : "down");
    }
    return row.observed ? observedStatus(row.observed) : "down";
}

/** Running / total containers, from whichever side of the merge knows. */
function rowCounts(row: Row): { running: number; total: number } {
    if (row.observed) {
        return { running: row.observed.running, total: row.observed.containers };
    }
    return { running: 0, total: row.status?.services.length ?? 0 };
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
    const task = useTaskAction();
    const [creating, setCreating] = useState(false);
    const [importing, setImporting] = useState(false);
    const [deleting, setDeleting] = useState<ComposeStack | null>(null);

    const host = servers.find((s) => s.id === serverId);

    const load = useCallback(async () => {
        try {
            // Adopts anything running that SC didn't know about, as a side
            // effect of the read — see HostComposeStacks.
            const next = await api("compose", "listForHost", { hostId: serverId });
            setState(next);
            setError(null);
            const entries = await Promise.all(next.stacks.map(async (s): Promise<[string, ComposeStackStatus | null]> => {
                try {
                    return [s.id, await api("compose", "getStatus", { stackId: s.id })];
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
    async function registeredAction(stack: ComposeStack, act: ComposeVerb) {
        if (act === "stop" && !confirm(`Stop "${stack.name}"?`)) {
            return;
        }
        if (act === "down" && !confirm(`Take down "${stack.name}"? Containers are removed; the stack's files are untouched.`)) {
            return;
        }
        if (await task.start(stack.project, { kind: "docker_compose_action", stackId: stack.id, action: act }, serverId)) {
            await load();
        }
    }

    async function observedAction(stack: DockerStack, act: StackAction) {
        if ((act === "stop" || act === "down") && !confirm(`${act} stack "${stack.project}"?`)) {
            return;
        }
        if (await task.start(stack.project, { kind: "docker_stack_action", project: stack.project, action: act }, serverId)) {
            await load();
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

            {(error ?? task.error) && <ErrorBanner>{error ?? task.error}</ErrorBanner>}

            {state.error && (
                <div className={shared.dim} style={{ fontSize: 12, marginBottom: 8 }}>
                    Live container state is unavailable ({state.error}) — showing last known registration only.
                </div>
            )}

            {rows.length === 0 ? (
                <EmptyState>No compose stacks yet — create one, or import a directory that already has a compose file.</EmptyState>
            ) : (
                <DetailedList>
                    {rows.map((row) => {
                        const { registered: reg, observed: obs } = row;
                        const location = reg ? reg.dir : (obs?.configFiles ?? "");
                        const runState = rowStatus(row);
                        const { running, total } = rowCounts(row);
                        const up = running > 0;
                        return (
                            <DetailedRow
                                key={row.project}
                                tone={stackTone(runState)}
                                busy={task.busyKey === row.project}
                                // A registered stack has a detail page to open; an adopted one
                                // only has its running containers to look at.
                                onClick={() => (reg ? onOpenStack(reg.id) : onViewContainers(row.project))}
                                title={row.label}
                                badge={(
                                    <>
                                        <StatusBadge tone={stackTone(runState)} title={obs ? obs.states.join(", ") : undefined}>
                                            {runState}
                                        </StatusBadge>
                                        {!reg && (
                                            <span
                                                className={cx(shared.badge, shared["badge-muted"])}
                                                title="Running on this host, but its containers carry no compose-file path to register it from"
                                            >
                                                no compose path
                                            </span>
                                        )}
                                    </>
                                )}
                                meta={(
                                    <span className={styles["count-meta"]}>
                                        <span className={shared["count-bar"]}>
                                            <span
                                                className={shared["count-bar-fill"]}
                                                style={{ width: total === 0 ? "0%" : `${(running / total) * 100}%` }}
                                            />
                                        </span>
                                        <span className={shared.mono}>{running}/{total}</span>
                                    </span>
                                )}
                                secondary={<span className={shared.mono} title={location}>{location || "—"}</span>}
                                // One contextual primary, everything else — destructive included —
                                // behind the menu. This used to be four buttons per row shouting
                                // over the data they belonged to.
                                actions={reg ? (
                                    <>
                                        {task.busyKey === row.project && <TaskProgress taskId={task.taskId} />}
                                        <button
                                            className={cx(shared.btn, shared["btn-sm"])}
                                            disabled={task.busy}
                                            onClick={() => void registeredAction(reg, up ? "restart" : "up")}
                                        >
                                            {up ? "Restart" : "Start"}
                                        </button>
                                        <ActionMenu
                                            disabled={task.busy}
                                            title={`Actions for ${row.label}`}
                                            items={[
                                                { label: "Open", onSelect: () => onOpenStack(reg.id) },
                                                { label: "View containers", onSelect: () => onViewContainers(row.project) },
                                                { label: "Start", disabled: up, onSelect: () => void registeredAction(reg, "up") },
                                                { label: "Stop", disabled: !up, onSelect: () => void registeredAction(reg, "stop") },
                                                { label: "Down", danger: true, disabled: total === 0, onSelect: () => void registeredAction(reg, "down") },
                                                { label: "Remove…", danger: true, onSelect: () => setDeleting(reg) },
                                            ]}
                                        />
                                    </>
                                ) : (
                                    <>
                                        {task.busyKey === row.project && <TaskProgress taskId={task.taskId} />}
                                        <button
                                            className={cx(shared.btn, shared["btn-sm"])}
                                            disabled={task.busy}
                                            onClick={() => void observedAction(obs!, up ? "restart" : "start")}
                                        >
                                            {up ? "Restart" : "Start"}
                                        </button>
                                        <ActionMenu
                                            disabled={task.busy}
                                            title={`Actions for ${row.label}`}
                                            items={[
                                                { label: "View containers", onSelect: () => onViewContainers(row.project) },
                                                { label: "Start", disabled: up, onSelect: () => void observedAction(obs!, "start") },
                                                { label: "Stop", disabled: !up, onSelect: () => void observedAction(obs!, "stop") },
                                                { label: "Down", danger: true, onSelect: () => void observedAction(obs!, "down") },
                                            ]}
                                        />
                                    </>
                                )}
                            />
                        );
                    })}
                </DetailedList>
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
