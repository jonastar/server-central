import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComposeStack, ComposeStackStatus, DirEntry, ServerEntry } from "@central/shared";
import type { ComposeStackTab } from "../routes";
import { api, runTaskAndWait } from "../api";
import { useConnection } from "../hooks/useConnection";
import { fmtDateTime, fmtRelative, cx } from "../utils";
import { fmtDuration, specSummary, statusTone } from "../taskFormat";
import { CodeEditor } from "./CodeEditor";
import { ComposeVisualEditor } from "./compose/ComposeVisualEditor";
import { DeleteComposeStackModal } from "./DeleteComposeStackModal";
import { FilesView } from "./FilesView";
import { LogViewer } from "./LogViewer";
import { ActionMenu, EmptyState, ErrorBanner } from "./ui";
import shared from "../styles/shared.module.css";

const REFRESH_MS = 10_000;

const STATUS_BADGE: Record<ComposeStackStatus["status"], "badge-ok" | "badge-warn" | "badge-muted"> = {
    running: "badge-ok",
    partial: "badge-warn",
    stopped: "badge-muted",
    down: "badge-muted",
};

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
export function ComposeStackView({ stackId, tab, servers, onNavigate, onBack, onOpenContainer }: {
    stackId: string;
    tab: ComposeStackTab;
    servers: ServerEntry[];
    onNavigate: (tab: ComposeStackTab) => void;
    onBack: () => void;
    /** Jump to a service's container on the host's Docker → Containers page,
     *  where inspect/exec/logs for that one container live. The filter scopes
     *  the list behind it to this stack, so closing the detail leaves you
     *  somewhere sensible rather than in the host's full container list. */
    onOpenContainer: (containerId: string, filter: string) => void;
}) {
    const conn = useConnection();
    const [stack, setStack] = useState<ComposeStack | null | undefined>(undefined);
    const [status, setStatus] = useState<ComposeStackStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
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

    async function runAction(action: ComposeVerb, opts?: { pullFirst?: boolean; autoOpenModal?: boolean; service?: string }) {
        if (!stack) {
            return;
        }
        // "Pull & up" is an `up` with pullFirst, but it's a distinct button (and a
        // distinct menu item) — give it its own busy key so only the control that
        // was actually clicked shows a pending label. It's not "pull" either: that
        // key belongs to the plain pull button sitting next to it.
        const verb = opts?.pullFirst ? "pull-up" : action;
        const busyId = opts?.service ? `${opts.service}:${verb}` : verb;
        setBusy(busyId);
        try {
            await runTaskAndWait(
                { kind: "docker_compose_action", stackId: stack.id, action, pullFirst: opts?.pullFirst, service: opts?.service },
                stack.hostId,
                { autoOpenModal: opts?.autoOpenModal },
            );
            await loadStatus();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    }

    if (stack === undefined) {
        return <EmptyState>Loading…</EmptyState>;
    }
    if (stack === null) {
        return <EmptyState>This stack is no longer registered.</EmptyState>;
    }

    const host = servers.find((s) => s.id === stack.hostId);
    const badge = status ? STATUS_BADGE[status.status] : "badge-muted";

    return (
        <div className={shared.view}>
            <header className={shared["view-header"]}>
                <button onClick={onBack} style={{ color: "var(--muted)", background: "none", border: "none", cursor: "pointer", font: "inherit", padding: 0 }}>
                    Docker / Compose stacks /
                </button>
                <h1 style={{ marginRight: 0 }}>{stack.name}</h1>
                <span className={cx(shared.badge, shared[badge])} style={{ marginRight: "auto" }}>
                    {status ? status.status : "unknown"}
                </span>
                <button
                    className={cx(shared.btn, shared["btn-sm"], shared["btn-danger"])}
                    disabled={busy !== null}
                    onClick={() => setDeleting(true)}
                >
                    Remove…
                </button>
            </header>

            {error && <ErrorBanner>{error}</ErrorBanner>}

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
                    busy={busy}
                    run={(action, opts) => runAction(action, opts)}
                    onOpenContainer={onOpenContainer}
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

/** `s.ports` is `formatPorts()`'s "8080→80, 9000→9000" — split back into
 *  published/target pairs so published ports can link straight to the host. */
function portPairs(ports: string): { published: string; target: string }[] {
    return ports.split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
        const [published, target] = p.split("→");
        return { published: published ?? p, target: target ?? "" };
    });
}

function PortsCell({ ports, hostIp }: { ports: string | undefined; hostIp: string | undefined }) {
    if (!ports) {
        return <>—</>;
    }
    if (!hostIp) {
        return <>{ports}</>;
    }
    const pairs = portPairs(ports);
    return (
        <>
            {pairs.map((p, i) => (
                <span key={i}>
                    {i > 0 && ", "}
                    <a href={`http://${hostIp}:${p.published}`} target="_blank" rel="noreferrer">
                        {p.published}{p.target ? `→${p.target}` : ""}
                    </a>
                </span>
            ))}
        </>
    );
}

type ComposeVerb = "up" | "restart" | "stop" | "down" | "pull";

type RunAction = (
    action: ComposeVerb,
    opts?: { pullFirst?: boolean; autoOpenModal?: boolean; service?: string },
) => void;

function OverviewTab({ stack, host, status, tasks, busy, run, onOpenContainer, onBrowseEntry }: {
    stack: ComposeStack;
    host: ServerEntry | undefined;
    status: ComposeStackStatus | null;
    tasks: import("@central/shared").TaskRun[];
    busy: string | null;
    run: RunAction;
    onOpenContainer: (containerId: string, filter: string) => void;
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

            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <button className={shared.btn} disabled={busy !== null} onClick={() => run("up")}>
                    {busy === "up" ? "Starting…" : "Start"}
                </button>
                <button className={shared.btn} disabled={busy !== null} onClick={() => run("restart")}>
                    {busy === "restart" ? "Restarting…" : "Restart"}
                </button>
                <button className={shared.btn} disabled={busy !== null} onClick={() => run("stop")}>
                    {busy === "stop" ? "Stopping…" : "Stop"}
                </button>
                <button
                    className={shared.btn}
                    disabled={busy !== null}
                    title="Fetch the stack's images without starting or recreating anything"
                    onClick={() => run("pull", { autoOpenModal: true })}
                >
                    {busy === "pull" ? "Pulling…" : "Pull"}
                </button>
                <button
                    className={cx(shared.btn, shared["btn-primary"])}
                    disabled={busy !== null}
                    onClick={() => run("up", { pullFirst: true, autoOpenModal: true })}
                >
                    {busy === "pull-up" ? "Pulling…" : "Pull & up"}
                </button>
                <button
                    className={cx(shared.btn, shared["btn-danger"])}
                    disabled={busy !== null}
                    style={{ marginLeft: "auto" }}
                    onClick={() => { if (confirm(`Take down "${stack.name}"? Containers are removed; the stack's files are untouched.`)) run("down"); }}
                >
                    {busy === "down" ? "Taking down…" : "Down"}
                </button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "minmax(340px, 1.6fr) minmax(320px, 1fr)", gap: 14, alignItems: "start" }}>
                <section className={shared.panel}>
                    <h3>Services ({status?.services.length ?? 0})</h3>
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
                                                    onClick={() => onOpenContainer(svc.containerId!, stack.project)}
                                                >
                                                    {svc.name}
                                                </button>
                                            ) : svc.name}
                                        </td>
                                        <td className={cx(shared.dim, shared.mono)} style={{ fontSize: 12 }}>{svc.image ?? "—"}</td>
                                        <td><span className={cx(shared.badge, svc.up ? shared["badge-ok"] : shared["badge-muted"])}>{svc.state ?? "down"}</span></td>
                                        <td className={shared.dim}><PortsCell ports={svc.ports} hostIp={host?.status.info?.primaryIp} /></td>
                                        <td style={{ textAlign: "right" }}>
                                            <ActionMenu
                                                disabled={busy !== null}
                                                title={`Actions for ${svc.name}`}
                                                items={[
                                                    {
                                                        label: "Open container",
                                                        disabled: !svc.containerId,
                                                        onSelect: () => svc.containerId && onOpenContainer(svc.containerId, stack.project),
                                                    },
                                                    { label: svc.up ? "Restart" : "Start", onSelect: () => run(svc.up ? "restart" : "up", { service: svc.name }) },
                                                    { label: "Stop", disabled: !svc.up, onSelect: () => run("stop", { service: svc.name }) },
                                                    { label: "Pull", onSelect: () => run("pull", { service: svc.name, autoOpenModal: true }) },
                                                    { label: "Pull & up", onSelect: () => run("up", { pullFirst: true, service: svc.name, autoOpenModal: true }) },
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
    const [path, setPath] = useState(initial?.path ?? stack.dir);
    const [file, setFile] = useState<string | null>(initial?.file ?? null);

    return (
        <FilesView
            serverId={stack.hostId}
            path={path}
            openFile={file}
            onNavigate={(patch) => {
                if (patch.path !== undefined) {
                    setPath(patch.path);
                }
                if ("file" in patch) {
                    setFile(patch.file ?? null);
                }
            }}
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
