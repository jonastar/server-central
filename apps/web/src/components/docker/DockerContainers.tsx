import { useCallback, useEffect, useState } from "react";
import type { ContainerAction, ContainerInfo, DockerState } from "@central/shared";
import { api } from "../../api";
import { useTaskAction } from "../../hooks/useTaskAction";
import { DetailedList, DetailedRow, DrawerLayout, EmptyState, ErrorBanner } from "../ui";
import { StatusFilter, type StatusToken } from "../StatusFilter";
import { ContainerDrawer } from "./ContainerDrawer";
import { PortLinks } from "./ports";
import { containerTone, StatusBadge } from "./status";
import shared from "../../styles/shared.module.css";

const REFRESH_MS = 10_000;

export function DockerContainers({ serverId, hostIp, stack, initialFilter, containerId, onOpenContainer, onCloseContainer, onClearStack }: {
    serverId: string;
    /** The host's address, so published ports can link straight to what's behind them. */
    hostIp?: string;
    /** Route-carried compose project the list is scoped to — set when you drill
     *  in from a stack. Shown as a removable chip, not as text in the search box:
     *  it's a scope you arrived with, not something you typed. */
    stack?: string;
    initialFilter?: string;
    /** Route-carried: which container's drawer is open. Routed rather than local
     *  state so a container can be linked to (the stack view's services table
     *  does) and survive a reload. */
    containerId?: string;
    onOpenContainer: (id: string) => void;
    onCloseContainer: () => void;
    onClearStack: () => void;
}) {
    const [docker, setDocker] = useState<DockerState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const task = useTaskAction();
    const [filter, setFilter] = useState(initialFilter ?? "");
    const [statusFilter, setStatusFilter] = useState<StatusToken>("all");

    const load = useCallback(async () => {
        try {
            setDocker(await api("docker", "list", { serverId }));
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [serverId]);

    useEffect(() => {
        setDocker(null);
        void load();
        const timer = setInterval(() => void load(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [load]);

    // Resolved from the loaded list; null while loading, or if the container in
    // the URL is gone — ContainerDrawer surfaces that itself.
    const selected = containerId ? (docker?.containers.find((c) => c.id === containerId) ?? null) : null;

    async function action(container: ContainerInfo, act: ContainerAction) {
        if (act === "remove" && !confirm(`Remove container "${container.name}"?`)) {
            return;
        }
        if (!await task.start(container.id, { kind: "docker_container_action", containerId: container.id, action: act }, serverId)) {
            return;
        }
        await load();
        if (act === "remove" && container.id === containerId) {
            onCloseContainer();
        }
    }

    const scoped = (docker?.containers ?? []).filter((c) => !stack || c.project === stack);
    const textFiltered = scoped.filter((c) => {
        if (!filter) {
            return true;
        }
        const q = filter.toLowerCase();
        return c.name.toLowerCase().includes(q)
            || c.image.toLowerCase().includes(q)
            || (c.project ?? "").toLowerCase().includes(q);
    });
    const counts = { all: textFiltered.length, ok: 0, warn: 0, err: 0 };
    for (const c of textFiltered) {
        counts[containerTone(c.state) as "ok" | "warn" | "err"]++;
    }
    const shown = textFiltered.filter((c) => statusFilter === "all" || containerTone(c.state) === statusFilter);

    return (
        <DrawerLayout>
            <section className={shared.panel}>
                <div className={shared["panel-head"]}>
                    <h3>Containers ({shown.length})</h3>
                    <input
                        className={shared["filter-input"]}
                        placeholder="Filter by name, image or stack…"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                    />
                    <StatusFilter
                        value={statusFilter}
                        onChange={setStatusFilter}
                        options={[
                            { value: "all", label: "All", count: counts.all },
                            { value: "ok", label: "Running", count: counts.ok },
                            { value: "warn", label: "Paused", count: counts.warn },
                            { value: "err", label: "Stopped", count: counts.err },
                        ]}
                    />
                </div>

                {stack && (
                    <div className={shared["scope-row"]}>
                        <button
                            type="button"
                            className={shared["scope-chip"]}
                            title="Show every container on this host"
                            onClick={onClearStack}
                        >
                            stack: <b>{stack}</b><span aria-hidden> ✕</span>
                        </button>
                        <span className={shared.dim}>filtered from the stack you came from</span>
                    </div>
                )}

                {(error ?? task.error) && <ErrorBanner>{error ?? task.error}</ErrorBanner>}
                {docker === null && !error && <EmptyState>Loading…</EmptyState>}
                {docker && !docker.available && (
                    <EmptyState>Docker is not available on this server{docker.error ? `: ${docker.error}` : "."}</EmptyState>
                )}

                {docker?.available && (shown.length === 0 ? (
                    <EmptyState>No matching containers.</EmptyState>
                ) : (
                    <DetailedList>
                        {shown.map((c) => {
                            const tone = containerTone(c.state);
                            const isOpen = containerId === c.id;
                            return (
                                <DetailedRow
                                    key={c.id}
                                    tone={tone}
                                    selected={isOpen}
                                    busy={task.busyKey === c.id}
                                    // The row only selects; every action lives in the drawer,
                                    // so there's one place a container is acted on.
                                    onClick={() => (isOpen ? onCloseContainer() : onOpenContainer(c.id))}
                                    title={c.name}
                                    badge={<StatusBadge tone={tone}>{c.state}</StatusBadge>}
                                    meta={c.status}
                                    secondary={(
                                        <>
                                            <span className={shared.mono}>{c.image}</span>
                                            <PortLinks ports={c.ports} hostIp={hostIp} />
                                            {!stack && c.project && <span>{c.project}</span>}
                                        </>
                                    )}
                                />
                            );
                        })}
                    </DetailedList>
                ))}
            </section>

            {containerId && (
                <ContainerDrawer
                    serverId={serverId}
                    containerId={containerId}
                    container={selected}
                    busy={task.busy}
                    taskId={task.busyKey === containerId ? task.taskId : null}
                    onAction={(container, act) => void action(container, act)}
                    onClose={onCloseContainer}
                />
            )}
        </DrawerLayout>
    );
}
