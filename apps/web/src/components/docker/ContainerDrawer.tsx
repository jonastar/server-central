import { useEffect, useState } from "react";
import type { ContainerAction, ContainerInfo, DockerContainerDetail, DockerMount } from "@central/shared";
import { api } from "../../api";
import { cx } from "../../utils";
import { ActionMenu, CodeBlock, DetailPair, Drawer, EmptyState, ErrorBanner, ExecBox, TaskProgress } from "../ui";
import { FilesView } from "../FilesView";
import { useHistoryState } from "../../hooks/useHistoryState";
import { LogViewerPane } from "../LogViewerModal";
import { TerminalView } from "../TerminalView";
import { containerTone, StatusBadge } from "./status";
import shared from "../../styles/shared.module.css";

type DrawerTab = "details" | "volumes" | "logs" | "exec" | "terminal" | "raw";

const TABS: Array<{ id: DrawerTab; label: string }> = [
    { id: "details", label: "Details" },
    { id: "volumes", label: "Volumes" },
    { id: "logs", label: "Logs" },
    { id: "exec", label: "Exec" },
    { id: "terminal", label: "Terminal" },
    { id: "raw", label: "Raw" },
];

/** One width for every tab. It scales with the viewport — a fixed pixel drawer
 *  is a sliver on a wide display and half the screen on a laptop — but it does
 *  not change as you switch tabs: a panel that resizes under the pointer makes
 *  the list beside it jump for no reason the operator asked for. */
const DRAWER_WIDTH = "clamp(520px, 46vw, 1200px)";

/** Tabs that scroll internally and want the drawer's whole height to do it in;
 *  the rest ride the drawer body's own scroller. */
const FILL: ReadonlySet<DrawerTab> = new Set<DrawerTab>(["volumes", "logs", "terminal"]);

/** A list that's long enough to bury everything under it — compose bookkeeping
 *  labels, mostly — is collapsed behind a "Show N" toggle. */
function Collapsible({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    if (count === 0) {
        return <DetailPair label={label}>—</DetailPair>;
    }
    return (
        <DetailPair label={label}>
            <button
                type="button"
                className={cx(shared.btn, shared["btn-sm"])}
                onClick={() => setOpen(!open)}
            >
                {open ? "Hide" : `Show ${count}`}
            </button>
            {open && <div style={{ marginTop: 6 }}>{children}</div>}
        </DetailPair>
    );
}

/**
 * The container's mounts, and a file browser rooted at whichever one you pick.
 *
 * Nothing new is needed on the host to do this: every bind and named volume
 * `docker inspect` reports carries an absolute *host* path in `source` (a named
 * volume's is /var/lib/docker/volumes/<name>/_data), so browsing it is the same
 * `listDir`/`readFile` the host Files tab already uses — the trick the volume
 * browser plays, aimed at one container instead of one volume.
 *
 * The limit is the flip side of that: this shows the container's mounted paths,
 * not its image layers. Anything the container writes outside a mount lives in
 * its overlay filesystem, which the agent has no path to — that needs the Exec
 * or Terminal tab.
 */
function MountBrowser({ serverId, containerId, mounts }: { serverId: string; containerId: string; mounts: DockerMount[] }) {
    // Which mount, which folder and which file are all below the route's
    // resolution — the hash stops at the container — so they ride the history
    // entry: Back walks back up the folders and out to the mounts list.
    const [nav, setNav] = useHistoryState<{ mount: string | null; path: string | null; file: string | null }>(
        `container-mounts:${containerId}`,
        { mount: null, path: null, file: null },
    );
    const open = nav.mount === null ? null : mounts.find((m) => m.destination === nav.mount) ?? null;

    if (open && nav.path) {
        return (
            <>
                <div className={shared["scope-row"]} style={{ marginBottom: 0, padding: "0 4px" }}>
                    <button
                        type="button"
                        className={cx(shared.btn, shared["btn-sm"])}
                        onClick={() => setNav({ mount: null, path: null, file: null })}
                    >
                        ← Mounts
                    </button>
                    <span className={shared.mono}>{open.destination}</span>
                    <span className={shared.dim}>in the container</span>
                </div>
                <FilesView
                    serverId={serverId}
                    path={nav.path}
                    openFile={nav.file}
                    onNavigate={(patch) => setNav({
                        mount: nav.mount,
                        path: patch.path ?? nav.path,
                        file: "file" in patch ? patch.file ?? null : nav.file,
                    })}
                />
            </>
        );
    }

    if (mounts.length === 0) {
        return <EmptyState>This container has no mounts — everything it writes lives in its own layer.</EmptyState>;
    }

    return (
        <div style={{ overflow: "auto" }}>
            <table className={shared["data-table"]}>
                <thead>
                    <tr><th>In container</th><th>Type</th><th>On host</th></tr>
                </thead>
                <tbody>
                    {mounts.map((m) => {
                        // tmpfs has no host path, and a named volume falls back to its
                        // bare name when inspect gives no Source — neither is browsable.
                        const browsable = m.source.startsWith("/");
                        return (
                            <tr
                                key={m.destination}
                                className={cx(browsable && shared["row-clickable"])}
                                title={browsable ? `Browse ${m.source}` : "Not a path on the host — nothing to browse"}
                                onClick={() => {
                                    if (browsable) {
                                        setNav({ mount: m.destination, path: m.source, file: null });
                                    }
                                }}
                            >
                                <td className={shared.mono}><b>{m.destination}</b></td>
                                <td className={shared.dim}>{m.type || "—"}</td>
                                <td className={cx(shared.dim, shared.mono, shared["cmd-cell"])} title={m.source}>
                                    {browsable ? m.source : <span>{m.source || "—"}</span>}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

/**
 * The one container detail surface. Whether you get here from the Containers
 * list or from a service row on a stack's Overview, it's this drawer, in the
 * Containers section, with the list still beside it — a stack drill-in just
 * arrives with the list already scoped to that stack.
 *
 * `container` is the row from the list (may be absent for a moment on a cold
 * deep-link, or for good if the container is gone); `detail` is the `docker
 * inspect` this fetches itself.
 */
export function ContainerDrawer({ serverId, containerId, container, busy, taskId, onAction, onClose }: {
    serverId: string;
    containerId: string;
    container: ContainerInfo | null;
    busy: boolean;
    /** Run started from these controls, while one is in flight. */
    taskId: string | null;
    onAction: (container: ContainerInfo, action: ContainerAction) => void;
    onClose: () => void;
}) {
    const [detail, setDetail] = useState<DockerContainerDetail | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<DrawerTab>("details");

    // The tab deliberately survives moving to another container: reading the same
    // tab down a list — logs, then the next one's logs — is the common case.
    useEffect(() => {
        let alive = true;
        setDetail(null);
        setError(null);
        api("dockerContainerInspect", { serverId, containerId })
            .then((d) => alive && setDetail(d))
            .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
        return () => { alive = false; };
    }, [serverId, containerId]);

    const name = container?.name ?? detail?.name ?? containerId.slice(0, 12);
    const state = container?.state ?? detail?.state ?? "";
    const status = container?.status ?? detail?.status ?? "";

    // Same shape as every other row's actions: one contextual primary, one
    // obvious sibling, everything else — destructive included — in the menu.
    const primary: { label: string; action: ContainerAction } = state === "running"
        ? { label: "Restart", action: "restart" }
        : state === "paused"
            ? { label: "Unpause", action: "unpause" }
            : { label: "Start", action: "start" };
    const menu = [
        ...(state === "running" ? [{ label: "Pause", onSelect: () => container && onAction(container, "pause") }] : []),
        { label: "Remove…", danger: true, onSelect: () => container && onAction(container, "remove") },
    ];

    const header = (
        <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className={shared.dim} style={{ fontSize: 12, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {container?.project ? `${container.project} / ${container.service ?? name}` : name}
                </span>
                <button className={shared["btn-icon"]} style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close">✕</button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                <b style={{ fontSize: 14 }}>{name}</b>
                {state && <StatusBadge tone={containerTone(state)} title={status}>{state}</StatusBadge>}
                <span className={cx(shared.mono, shared.dim)}>{containerId.slice(0, 12)}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
                <button
                    className={cx(shared.btn, shared["btn-sm"])}
                    disabled={busy || !container}
                    onClick={() => container && onAction(container, primary.action)}
                >
                    {primary.label}
                </button>
                <button
                    className={cx(shared.btn, shared["btn-sm"])}
                    disabled={busy || !container || state !== "running"}
                    onClick={() => container && onAction(container, "stop")}
                >
                    Stop
                </button>
                <ActionMenu disabled={busy || !container} title={`Actions for ${name}`} items={menu} />
                {busy && <TaskProgress taskId={taskId} />}
            </div>
            <div className={shared["sub-tabs"]} style={{ marginTop: 8 }}>
                {TABS.map((t) => (
                    <button key={t.id} className={cx(shared["sub-tab"], tab === t.id && shared.active)} onClick={() => setTab(t.id)}>
                        {t.label}
                    </button>
                ))}
            </div>
        </>
    );

    return (
        <Drawer onClose={onClose} header={header} width={DRAWER_WIDTH} fill={FILL.has(tab)} backLabel="← Containers">
            {error && <ErrorBanner>{error}</ErrorBanner>}

            {tab === "logs" && (
                <LogViewerPane
                    caps={{ timestamps: true }}
                    fetchLogs={(q) => api("dockerContainerLogs", { serverId, containerId, ...q }).then((r) => r.logs)}
                />
            )}
            {tab === "volumes" && detail && <MountBrowser serverId={serverId} containerId={containerId} mounts={detail.mounts} />}
            {tab === "terminal" && <TerminalView serverId={serverId} containerId={containerId} />}
            {tab === "exec" && (
                <ExecBox
                    placeholder="e.g. ls /app, cat /etc/hosts…"
                    onRun={(command) => api("dockerContainerExec", { serverId, containerId, command })}
                />
            )}

            {!detail && !error && (tab === "details" || tab === "raw" || tab === "volumes") && <EmptyState>Loading…</EmptyState>}

            {detail && tab === "details" && (
                <div className={shared["detail-grid"]}>
                    <DetailPair label="State">{detail.state} ({detail.status})</DetailPair>
                    <DetailPair label="Image"><span className={shared.mono}>{detail.image}</span></DetailPair>
                    <DetailPair label="Stack">
                        {container?.project ?? "—"}{container?.service ? ` / ${container.service}` : ""}
                    </DetailPair>
                    <DetailPair label="Command"><span className={shared.mono}>{detail.command || "—"}</span></DetailPair>
                    <DetailPair label="Restart">{detail.restartPolicy}</DetailPair>
                    <DetailPair label="Networks">{detail.networks.join(", ") || "—"}</DetailPair>
                    <DetailPair label="Ports">
                        {detail.ports.length === 0 ? "—" : (
                            <ul className={cx(shared["detail-list"], shared.mono)}>{detail.ports.map((p) => <li key={p}>{p}</li>)}</ul>
                        )}
                    </DetailPair>
                    <DetailPair label="Mounts">
                        {detail.mounts.length === 0 ? "—" : (
                            <ul className={cx(shared["detail-list"], shared.mono)}>
                                {detail.mounts.map((m) => <li key={m.destination}>{m.source} → {m.destination} <span className={shared.dim}>({m.type})</span></li>)}
                            </ul>
                        )}
                    </DetailPair>
                    <Collapsible label="Env" count={detail.env.length}>
                        <ul className={cx(shared["detail-list"], shared.mono)}>{detail.env.map((e) => <li key={e}>{e}</li>)}</ul>
                    </Collapsible>
                    <Collapsible label="Labels" count={detail.labels.length}>
                        <ul className={cx(shared["detail-list"], shared.mono)}>
                            {detail.labels.map((l) => <li key={l.key}>{l.key}=<span className={shared.dim}>{l.value}</span></li>)}
                        </ul>
                    </Collapsible>
                </div>
            )}

            {detail && tab === "raw" && <CodeBlock text={detail.raw} />}
        </Drawer>
    );
}
