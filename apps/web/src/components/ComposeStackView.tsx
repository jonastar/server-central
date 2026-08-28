import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComposeStack, ComposeStackStatus, DirEntry, ServerEntry } from "@central/shared";
import type { ComposeStackTab } from "../routes";
import { api } from "../api";
import { useTaskAction } from "../hooks/useTaskAction";
import { useConnection } from "../hooks/useConnection";
import { fmtDateTime, fmtRelative, cx } from "../utils";
import { fmtDuration, specSummary, statusTone } from "../taskFormat";
import { CodeEditor } from "./CodeEditor";
import { PortLinks } from "./docker/ports";
import { serviceState, serviceTone, stackTone, StatusBadge } from "./docker/status";
import { ComposeVisualEditor } from "./compose/ComposeVisualEditor";
import { DeleteComposeStackModal } from "./DeleteComposeStackModal";
import { FilesView } from "./FilesView";
import { useHistoryState } from "../hooks/useHistoryState";
import { LogViewer } from "./LogViewer";
import { ActionMenu, EmptyState, ErrorBanner, TaskProgress } from "./ui";
import shared from "../styles/shared.module.css";

const REFRESH_MS = 10_000;

function InfoChip({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
    return (
        <div className={shared["info-chip"]}>
            <span className={shared["info-chip-label"]}>{label}</span>
            <span className={cx(shared["info-chip-value"], mono && shared.mono)}>{value}</span>
        </div>
    );
}

/** Tabbed detail for one SC-managed compose stack — design refs 1d (Overview)
 *  - 1h (Logs), the `ServerOverview` + sub-tabs pattern. Reached from the host's
 *  Docker → Stacks section, whose page shell it replaces. */
export function ComposeStackView({ stackId, tab, servers, onNavigate, onBack, onOpenContainers }: {
    stackId: string;
    tab: ComposeStackTab;
    servers: ServerEntry[];
    onNavigate: (tab: ComposeStackTab) => void;
    onBack: () => void;
    /** Jump to the host's Docker → Containers page with the list scoped to this
     *  stack. Passing a containerId opens its drawer there as well — the same
     *  drawer either way, so a service row and a container row lead to one
     *  surface, and closing it leaves you in this stack's containers rather than
     *  the host's full list. */
    onOpenContainers: (project: string, containerId?: string) => void;
}) {
    const conn = useConnection();
    const [stack, setStack] = useState<ComposeStack | null | undefined>(undefined);
    const [status, setStatus] = useState<ComposeStackStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const task = useTaskAction();
    // Where the Files tab should open to — set by Overview's per-entry Browse
    // buttons just before switching tabs, cleared on a direct click of the Files
    // nav tab so that always starts back at the stack's own folder.
    const [filesInitial, setFilesInitial] = useState<{ path: string; file: string | null } | null>(null);
    const [deleting, setDeleting] = useState(false);

    const loadStack = useCallback(async () => {
        try {
            const list = await api("listComposeStacks", undefined);
            setStack(list.find((a) => a.id === stackId) ?? null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [stackId]);

    const loadStatus = useCallback(async () => {
        try {
            setStatus(await api("getComposeStackStatus", { stackId }));
        } catch {
            setStatus(null);
        }
    }, [stackId]);

    useEffect(() => {
        setStack(undefined);
        void loadStack();
    }, [loadStack]);

    useEffect(() => {
        void loadStatus();
        const timer = setInterval(() => void loadStatus(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [loadStatus]);

    async function runAction(action: ComposeVerb, opts?: { pullFirst?: boolean; watch?: boolean; service?: string }) {
        if (!stack) {
            return;
        }
        // "Pull & up" is an `up` with pullFirst, but it's a distinct button (and a
        // distinct menu item) — give it its own busy key so only the control that
        // was actually clicked shows a pending label. It's not "pull" either: that
        // key belongs to the plain pull button sitting next to it.
        const verb = opts?.pullFirst ? "pull-up" : action;
        const busyId = opts?.service ? `${opts.service}:${verb}` : verb;
        const run = await task.start(
            busyId,
            { kind: "docker_compose_action", stackId: stack.id, action, pullFirst: opts?.pullFirst, service: opts?.service },
            stack.hostId,
            { feedback: opts?.watch ? "modal" : "progress" },
        );
        if (run) {
            await loadStatus();
        }
    }

    if (stack === undefined) {
        return <EmptyState>Loading…</EmptyState>;
    }
    if (stack === null) {
        return <EmptyState>This stack is no longer registered.</EmptyState>;
    }

    const host = servers.find((s) => s.id === stack.hostId);
    const up = (status?.services ?? []).some((s) => s.up);

    return (
        <div className={shared.view}>
            {/* The stack's actions live in the header, not on the Overview tab: they
                apply to the stack whichever tab you're reading, and it's the same
                primary + overflow shape every row in the Docker section now uses. */}
            <header className={shared["view-header"]}>
                <button onClick={onBack} style={{ color: "var(--muted)", background: "none", border: "none", cursor: "pointer", font: "inherit", padding: 0 }}>
                    Docker / Compose stacks /
                </button>
                <h1 style={{ marginRight: 0 }}>{stack.name}</h1>
                <span style={{ marginRight: "auto" }}>
                    {status
                        ? <StatusBadge tone={stackTone(status.status)}>{status.status}</StatusBadge>
                        : <StatusBadge tone="muted">unknown</StatusBadge>}
                </span>
                <button
                    className={cx(shared.btn, shared["btn-sm"], shared["btn-primary"])}
                    disabled={task.busy}
                    onClick={() => void runAction("up", { pullFirst: true, watch: true })}
                >
                    {task.busyKey === "pull-up" ? "Pulling…" : "Pull & up"}
                </button>
                <button
                    className={cx(shared.btn, shared["btn-sm"])}
                    disabled={task.busy}
                    onClick={() => void runAction(up ? "restart" : "up")}
                >
                    {task.busyKey === "restart" ? "Restarting…" : task.busyKey === "up" ? "Starting…" : up ? "Restart" : "Start"}
                </button>
                <ActionMenu
                    disabled={task.busy}
                    title={`Actions for ${stack.name}`}
                    items={[
                        { label: "Start", disabled: up, onSelect: () => void runAction("up") },
                        { label: "Stop", disabled: !up, onSelect: () => void runAction("stop") },
                        { label: "Pull", onSelect: () => void runAction("pull", { watch: true }) },
                        { label: "View containers", onSelect: () => onOpenContainers(stack.project) },
                        {
                            label: "Down",
                            danger: true,
                            onSelect: () => {
                                if (confirm(`Take down "${stack.name}"? Containers are removed; the stack's files are untouched.`)) {
                                    void runAction("down");
                                }
                            },
                        },
                        { label: "Remove…", danger: true, onSelect: () => setDeleting(true) },
                    ]}
                />
                {task.busy && <TaskProgress taskId={task.taskId} />}
            </header>

            {(error ?? task.error) && <ErrorBanner>{error ?? task.error}</ErrorBanner>}

            <nav className={shared["sub-tabs"]}>
                {([
                    { id: "overview", label: "Overview" },
                    { id: "compose", label: "Compose" },
                    { id: "files", label: "Files" },
                    { id: "logs", label: "Logs" },
                ] as const).map((t) => (
                    <button
                        key={t.id}
                        className={cx(shared["sub-tab"], tab === t.id && shared.active)}
                        onClick={() => { if (t.id === "files") setFilesInitial(null); onNavigate(t.id); }}
                    >
                        {t.label}
                    </button>
                ))}
            </nav>

            {tab === "overview" && (
                <OverviewTab
                    stack={stack}
                    host={host}
                    status={status}
                    tasks={conn.tasks}
                    busy={task.busyKey}
                    taskId={task.taskId}
                    run={(action, opts) => runAction(action, opts)}
                    onOpenContainers={onOpenContainers}
                    onBrowseEntry={(entry) => {
                        const fullPath = `${stack.dir}/${entry.name}`;
                        setFilesInitial(entry.type === "dir"
                            ? { path: fullPath, file: null }
                            : { path: stack.dir, file: fullPath });
                        onNavigate("files");
                    }}
                />
            )}
            {tab === "compose" && <ComposeTab stack={stack} onSaved={loadStatus} onUp={() => runAction("up")} />}
            {tab === "files" && <FilesTab stack={stack} initial={filesInitial} />}
            {tab === "logs" && <LogsTab stack={stack} status={status} />}

            {deleting && (
                <DeleteComposeStackModal
                    stack={stack}
                    host={host}
                    running={(status?.services ?? []).some((s) => s.up)}
                    onClose={() => setDeleting(false)}
                    onDeleted={onBack}
                />
            )}
        </div>
    );
}

// ---- Overview -------------------------------------------------------------------

type ComposeVerb = "up" | "restart" | "stop" | "down" | "pull";

type RunAction = (
    action: ComposeVerb,
    opts?: { pullFirst?: boolean; watch?: boolean; service?: string },
) => void;

function OverviewTab({ stack, host, status, tasks, busy, taskId, run, onOpenContainers, onBrowseEntry }: {
    stack: ComposeStack;
    host: ServerEntry | undefined;
    status: ComposeStackStatus | null;
    tasks: import("@central/shared").TaskRun[];
    busy: string | null;
    /** Run the busy control started, for its progress affordance. */
    taskId: string | null;
    run: RunAction;
    onOpenContainers: (project: string, containerId?: string) => void;
    onBrowseEntry: (entry: DirEntry) => void;
}) {
    const [dirEntries, setDirEntries] = useState<DirEntry[] | null>(null);

    useEffect(() => {
        let alive = true;
        api("listDir", { serverId: stack.hostId, path: stack.dir })
            .then((d) => alive && setDirEntries(d.entries))
            .catch(() => alive && setDirEntries([]));
        return () => { alive = false; };
    }, [stack.hostId, stack.dir]);

    const recentRuns = useMemo(() => tasks
        .filter((t) => t.spec.kind === "docker_compose_action" && t.spec.stackId === stack.id)
        .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt))
        .slice(0, 5), [tasks, stack.id]);

    return (
        <>
            <div className={shared["info-chips"]}>
                <InfoChip label="Host" value={host?.name ?? stack.hostId} />
                <InfoChip label="Directory" value={stack.dir} mono />
                <InfoChip label="Compose file" value={stack.composeFile} mono />
                <InfoChip label="Project" value={stack.project} mono />
                <InfoChip label="Created" value={fmtDateTime(stack.createdAt)} />
                <InfoChip label="Manifest" value="sc-stack.json" mono />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "minmax(340px, 1.6fr) minmax(320px, 1fr)", gap: 14, alignItems: "start" }}>
                <section className={shared.panel}>
                    <div className={shared["panel-head"]}>
                        <h3>Services · containers ({status?.services.length ?? 0})</h3>
                        <button
                            type="button"
                            className={cx(shared.btn, shared["btn-sm"])}
                            title="This stack's containers in the host's container list"
                            onClick={() => onOpenContainers(stack.project)}
                        >
                            Open in Containers ↗
                        </button>
                    </div>
                    {!status || status.services.length === 0 ? (
                        <EmptyState>No services declared yet.</EmptyState>
                    ) : (
                        <table className={shared["data-table"]}>
                            <thead>
                                <tr><th>Service</th><th>Image</th><th>State</th><th>Ports</th><th /></tr>
                            </thead>
                            <tbody>
                                {status.services.map((svc) => (
                                    <tr key={svc.name} className={cx(busy?.startsWith(`${svc.name}:`) && shared["row-busy"])}>
                                        <td style={{ fontWeight: 600 }}>
                                            {svc.containerId ? (
                                                <button
                                                    type="button"
                                                    style={{ border: "none", background: "none", padding: 0, font: "inherit", fontWeight: 600, color: "var(--accent)", cursor: "pointer", textAlign: "left" }}
                                                    title="Open this service's container"
                                                    onClick={() => onOpenContainers(stack.project, svc.containerId!)}
                                                >
                                                    {svc.name}
                                                </button>
                                            ) : svc.name}
                                        </td>
                                        <td className={cx(shared.dim, shared.mono)} style={{ fontSize: 12 }}>{svc.image ?? "—"}</td>
                                        <td><StatusBadge tone={serviceTone(svc)}>{serviceState(svc)}</StatusBadge></td>
                                        <td className={shared.dim}><PortLinks ports={svc.ports} hostIp={host?.status.info?.primaryIp} /></td>
                                        <td className={shared["row-actions-always"]}>
                                            {/* A service row and a container row are the same row —
                                                Inspect opens the same drawer the Containers list does. */}
                                            <button
                                                type="button"
                                                className={cx(shared.btn, shared["btn-sm"])}
                                                disabled={!svc.containerId}
                                                title={svc.containerId ? "Open this service's container" : "This service has no container right now"}
                                                onClick={() => svc.containerId && onOpenContainers(stack.project, svc.containerId)}
                                            >
                                                Inspect →
                                            </button>
                                            {busy?.startsWith(`${svc.name}:`) && <TaskProgress taskId={taskId} />}
                                            <ActionMenu
                                                disabled={busy !== null}
                                                title={`Actions for ${svc.name}`}
                                                items={[
                                                    { label: svc.up ? "Restart" : "Start", onSelect: () => run(svc.up ? "restart" : "up", { service: svc.name }) },
                                                    { label: "Stop", disabled: !svc.up, onSelect: () => run("stop", { service: svc.name }) },
                                                    { label: "Pull", onSelect: () => run("pull", { service: svc.name, watch: true }) },
                                                    { label: "Pull & up", onSelect: () => run("up", { pullFirst: true, service: svc.name, watch: true }) },
                                                    {
                                                        label: "Down",
                                                        danger: true,
                                                        onSelect: () => {
                                                            if (confirm(`Take down service "${svc.name}"? Its container is removed; the rest of the stack is untouched.`)) {
                                                                run("down", { service: svc.name });
                                                            }
                                                        },
                                                    },
                                                ]}
                                            />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </section>

                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    <section className={shared.panel}>
                        <h3>Recent task runs</h3>
                        {recentRuns.length === 0 ? (
                            <EmptyState>No runs yet.</EmptyState>
                        ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                {recentRuns.map((run) => (
                                    <div key={run.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                        <span className={cx(shared.badge, shared[`badge-${statusTone(run.status)}`])}>{run.status}</span>
                                        <span className={shared.mono} style={{ fontSize: 12 }}>{specSummary(run.spec)}</span>
                                        <span className={shared.dim} style={{ marginLeft: "auto", fontSize: 12 }}>
                                            {fmtRelative(run.finishedAt ?? run.createdAt)} · {fmtDuration(run)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>
                    <section className={shared.panel}>
                        <h3>Files</h3>
                        {!dirEntries ? (
                            <EmptyState>Loading…</EmptyState>
                        ) : dirEntries.length === 0 ? (
                            <EmptyState>This folder is empty.</EmptyState>
                        ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                {dirEntries.map((e) => (
                                    <div key={e.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                        <span className={shared.dim} style={{ fontSize: 12, flex: 1 }}>{e.name}{e.type === "dir" ? "/" : ""}</span>
                                        <button
                                            type="button"
                                            className={cx(shared.btn, shared["btn-sm"])}
                                            onClick={() => onBrowseEntry(e)}
                                        >
                                            Browse
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>
                </div>
            </div>
        </>
    );
}

// ---- Compose --------------------------------------------------------------------

function ComposeTab({ stack, onSaved, onUp }: { stack: ComposeStack; onSaved: () => void; onUp: () => void }) {
    const composePath = `${stack.dir}/${stack.composeFile}`;
    const [original, setOriginal] = useState<string | null>(null);
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [mode, setMode] = useState<"visual" | "yaml">("visual");

    useEffect(() => {
        let alive = true;
        setOriginal(null);
        api("readFile", { serverId: stack.hostId, path: composePath })
            .then((f) => { if (alive) { setOriginal(f.content); setValue(f.content); } })
            .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
        return () => { alive = false; };
    }, [stack.hostId, composePath]);

    const dirty = original !== null && value !== original;

    async function save(andUp: boolean) {
        setSaving(true);
        setError(null);
        try {
            await api("writeFile", { serverId: stack.hostId, path: composePath, content: value });
            setOriginal(value);
            if (andUp) {
                onUp();
            }
            onSaved();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    if (original === null) {
        return error ? <ErrorBanner>{error}</ErrorBanner> : <EmptyState>Loading…</EmptyState>;
    }

    return (
        <div className={shared.panel} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }}>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--border)", background: "var(--panel-2)" }}>
                <span className={shared.mono} style={{ fontSize: 12 }}>{composePath}</span>
                {dirty && <span className={cx(shared.badge, shared["badge-warn"])}>unsaved changes</span>}
                <div style={{ display: "flex", marginLeft: "auto" }}>
                    <button className={cx(shared["sub-tab"], mode === "visual" && shared.active)} onClick={() => setMode("visual")}>Visual</button>
                    <button className={cx(shared["sub-tab"], mode === "yaml" && shared.active)} onClick={() => setMode("yaml")}>YAML</button>
                </div>
                <span className={shared.dim} style={{ fontSize: 12 }}>yaml · {value.split("\n").length} lines</span>
                <button className={cx(shared.btn, shared["btn-sm"])} disabled={!dirty || saving} onClick={() => setValue(original)}>Revert</button>
                <button className={cx(shared.btn, shared["btn-sm"])} disabled={!dirty || saving} onClick={() => void save(false)}>
                    {saving ? "Saving…" : "Save"}
                </button>
                <button className={cx(shared.btn, shared["btn-sm"], shared["btn-primary"])} disabled={saving} onClick={() => void save(true)}>
                    Save &amp; up
                </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
                {mode === "visual" ? (
                    <ComposeVisualEditor value={value} onChange={setValue} hostId={stack.hostId} stackDir={stack.dir} />
                ) : (
                    <CodeEditor path={composePath} value={value} onChange={setValue} onSave={() => void save(false)} />
                )}
            </div>
            <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", background: "var(--panel-2)", color: "var(--muted)", fontSize: 12 }}>
                Saving writes the file on <b>{stack.hostId}</b> only — it does not restart anything. Use <b>Save &amp; up</b> to apply.
            </div>
        </div>
    );
}

// ---- Files ----------------------------------------------------------------------

/** The stack's own folder — the level the compose file sits at, not a subfolder
 *  of it. Bind mounts live wherever the compose file points them; SC doesn't
 *  impose a layout, so there's nothing narrower to root this at. */
function FilesTab({ stack, initial }: { stack: ComposeStack; initial: { path: string; file: string | null } | null }) {
    // Folder and open file aren't in the hash here (the route stops at the
    // stack's Files tab), so they ride the history entry instead — Back steps
    // back up the folder trail rather than out of the stack.
    const [nav, setNav] = useHistoryState<{ path: string; file: string | null }>(
        `compose-files:${stack.id}`,
        { path: initial?.path ?? stack.dir, file: initial?.file ?? null },
    );

    return (
        <FilesView
            serverId={stack.hostId}
            path={nav.path}
            openFile={nav.file}
            onNavigate={(patch) => setNav({
                path: patch.path ?? nav.path,
                file: "file" in patch ? patch.file ?? null : nav.file,
            })}
        />
    );
}

// ---- Logs -----------------------------------------------------------------------

function LogsTab({ stack, status }: { stack: ComposeStack; status: ComposeStackStatus | null }) {
    const [service, setService] = useState("");
    const [tail, setTail] = useState(500);
    const [logs, setLogs] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const { logs: text } = await api("getComposeStackLogs", { stackId: stack.id, service: service || undefined, tail });
            setLogs(text);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [stack.id, service, tail]);

    useEffect(() => { void load(); }, [load]);

    return (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            <LogViewer
                text={logs}
                loading={loading}
                onRefresh={() => void load()}
                controls={(
                    <>
                        <select value={service} onChange={(e) => setService(e.target.value)}>
                            <option value="">All services</option>
                            {(status?.services ?? []).map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
                        </select>
                        <select value={tail} onChange={(e) => setTail(Number(e.target.value))}>
                            <option value={100}>Last 100 lines</option>
                            <option value={500}>Last 500 lines</option>
                            <option value={2000}>Last 2000 lines</option>
                        </select>
                    </>
                )}
            />
        </div>
    );
}
