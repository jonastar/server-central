import { useCallback, useEffect, useMemo, useState } from "react";
import type { App, AppStatus, DirEntry, ServerEntry } from "@central/shared";
import type { AppTab } from "../routes";
import { api, runTaskAndWait } from "../api";
import { useConnection } from "../hooks/useConnection";
import { fmtDateTime, fmtRelative, cx } from "../utils";
import { fmtDuration, specSummary, statusTone } from "../taskFormat";
import { CodeEditor } from "./CodeEditor";
import { ComposeVisualEditor } from "./compose/ComposeVisualEditor";
import { DeleteAppModal } from "./DeleteAppModal";
import { FilesView } from "./FilesView";
import { LogViewer } from "./LogViewer";
import { EmptyState, ErrorBanner } from "./ui";
import shared from "../styles/shared.module.css";

const REFRESH_MS = 10_000;

const STATUS_BADGE: Record<AppStatus["status"], "badge-ok" | "badge-warn" | "badge-muted"> = {
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

/** Tabbed App detail — design refs 1d (Overview) - 1h (Logs), the
 *  `ServerOverview` + sub-tabs pattern. */
export function AppView({ appId, tab, servers, onNavigate, onBack }: {
    appId: string;
    tab: AppTab;
    servers: ServerEntry[];
    onNavigate: (tab: AppTab) => void;
    onBack: () => void;
}) {
    const conn = useConnection();
    const [app, setApp] = useState<App | null | undefined>(undefined);
    const [status, setStatus] = useState<AppStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    // Where the Volumes tab should open to — set by Overview's per-entry
    // Browse buttons just before switching tabs, cleared on a direct click of
    // the Volumes nav tab so that always starts back at the volumes/ root.
    const [volumesInitial, setVolumesInitial] = useState<{ path: string; file: string | null } | null>(null);

    const loadApp = useCallback(async () => {
        try {
            const list = await api("listApps", undefined);
            setApp(list.find((a) => a.id === appId) ?? null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [appId]);

    const loadStatus = useCallback(async () => {
        try {
            setStatus(await api("getAppStatus", { appId }));
        } catch {
            setStatus(null);
        }
    }, [appId]);

    useEffect(() => {
        setApp(undefined);
        void loadApp();
    }, [loadApp]);

    useEffect(() => {
        void loadStatus();
        const timer = setInterval(() => void loadStatus(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [loadStatus]);

    async function runAction(action: "up" | "restart" | "stop" | "down", opts?: { pullFirst?: boolean; autoOpenModal?: boolean; service?: string }) {
        if (!app) {
            return;
        }
        const busyId = opts?.service ? `${opts.service}:${action}` : action;
        setBusy(busyId);
        try {
            await runTaskAndWait(
                { kind: "docker_compose_action", appId: app.id, action, pullFirst: opts?.pullFirst, service: opts?.service },
                app.hostId,
                { autoOpenModal: opts?.autoOpenModal },
            );
            await loadStatus();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    }

    if (app === undefined) {
        return <EmptyState>Loading…</EmptyState>;
    }
    if (app === null) {
        return <EmptyState>This app no longer exists.</EmptyState>;
    }

    const host = servers.find((s) => s.id === app.hostId);
    const badge = status ? STATUS_BADGE[status.status] : "badge-muted";

    return (
        <div className={shared.view}>
            <header className={shared["view-header"]}>
                <button onClick={onBack} style={{ color: "var(--muted)", background: "none", border: "none", cursor: "pointer", font: "inherit", padding: 0 }}>
                    Apps /
                </button>
                <h1 style={{ marginRight: 0 }}>{app.name}</h1>
                <span className={cx(shared.badge, shared[badge])} style={{ marginRight: "auto" }}>
                    {status ? status.status : "unknown"}
                </span>
                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy !== null} onClick={() => void runAction("restart")}>
                    {busy === "restart" ? "Restarting…" : "Restart"}
                </button>
                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy !== null} onClick={() => void runAction("stop")}>
                    {busy === "stop" ? "Stopping…" : "Stop"}
                </button>
                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy !== null} onClick={() => void runAction("up", { pullFirst: true, autoOpenModal: true })}>
                    Pull
                </button>
            </header>

            {error && <ErrorBanner>{error}</ErrorBanner>}

            <nav className={shared["sub-tabs"]}>
                {([
                    { id: "overview", label: "Overview" },
                    { id: "compose", label: "Compose" },
                    { id: "volumes", label: "Volumes" },
                    { id: "controls", label: "Controls" },
                    { id: "logs", label: "Logs" },
                ] as const).map((t) => (
                    <button
                        key={t.id}
                        className={cx(shared["sub-tab"], tab === t.id && shared.active)}
                        onClick={() => { if (t.id === "volumes") setVolumesInitial(null); onNavigate(t.id); }}
                    >
                        {t.label}
                    </button>
                ))}
            </nav>

            {tab === "overview" && (
                <OverviewTab
                    app={app}
                    host={host}
                    status={status}
                    tasks={conn.tasks}
                    onBrowseVolume={(entry) => {
                        const fullPath = `${app.dir}/volumes/${entry.name}`;
                        setVolumesInitial(entry.type === "dir"
                            ? { path: fullPath, file: null }
                            : { path: `${app.dir}/volumes`, file: fullPath });
                        onNavigate("volumes");
                    }}
                />
            )}
            {tab === "compose" && <ComposeTab app={app} onSaved={loadStatus} onUp={() => runAction("up")} />}
            {tab === "volumes" && <VolumesTab app={app} initial={volumesInitial} />}
            {tab === "controls" && (
                <ControlsTab
                    app={app}
                    host={host}
                    status={status}
                    busy={busy}
                    run={(action, opts) => runAction(action, opts)}
                    onDeleted={onBack}
                />
            )}
            {tab === "logs" && <LogsTab app={app} status={status} />}
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

function OverviewTab({ app, host, status, tasks, onBrowseVolume }: {
    app: App;
    host: ServerEntry | undefined;
    status: AppStatus | null;
    tasks: import("@central/shared").TaskRun[];
    onBrowseVolume: (entry: DirEntry) => void;
}) {
    const [volumeDirs, setVolumeDirs] = useState<DirEntry[] | null>(null);

    useEffect(() => {
        let alive = true;
        api("listDir", { serverId: app.hostId, path: `${app.dir}/volumes` })
            .then((d) => alive && setVolumeDirs(d.entries))
            .catch(() => alive && setVolumeDirs([]));
        return () => { alive = false; };
    }, [app.hostId, app.dir]);

    const recentRuns = useMemo(() => tasks
        .filter((t) => t.spec.kind === "docker_compose_action" && t.spec.appId === app.id)
        .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt))
        .slice(0, 5), [tasks, app.id]);

    return (
        <>
            <div className={shared["info-chips"]}>
                <InfoChip label="Host" value={host?.name ?? app.hostId} />
                <InfoChip label="Directory" value={app.dir} mono />
                <InfoChip label="Compose file" value={app.composeFile} mono />
                <InfoChip label="Project" value={app.project} mono />
                <InfoChip label="Created" value={fmtDateTime(app.createdAt)} />
                <InfoChip label="Manifest" value="sc-app.json" mono />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "minmax(340px, 1.6fr) minmax(320px, 1fr)", gap: 14, alignItems: "start" }}>
                <section className={shared.panel}>
                    <h3>Services ({status?.services.length ?? 0})</h3>
                    {!status || status.services.length === 0 ? (
                        <EmptyState>No services declared yet.</EmptyState>
                    ) : (
                        <table className={shared["data-table"]}>
                            <thead>
                                <tr><th>Service</th><th>Image</th><th>State</th><th>Ports</th></tr>
                            </thead>
                            <tbody>
                                {status.services.map((s) => (
                                    <tr key={s.name}>
                                        <td style={{ fontWeight: 600 }}>{s.name}</td>
                                        <td className={cx(shared.dim, shared.mono)} style={{ fontSize: 12 }}>{s.image ?? "—"}</td>
                                        <td><span className={cx(shared.badge, s.up ? shared["badge-ok"] : shared["badge-muted"])}>{s.state ?? "down"}</span></td>
                                        <td className={shared.dim}><PortsCell ports={s.ports} hostIp={host?.status.info?.primaryIp} /></td>
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
                        <h3>Volumes</h3>
                        {!volumeDirs ? (
                            <EmptyState>Loading…</EmptyState>
                        ) : volumeDirs.length === 0 ? (
                            <EmptyState>Nothing under volumes/ yet.</EmptyState>
                        ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                {volumeDirs.map((e) => (
                                    <div key={e.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                        <span className={shared.dim} style={{ fontSize: 12, flex: 1 }}>{e.name}{e.type === "dir" ? "/" : ""}</span>
                                        <button
                                            type="button"
                                            className={cx(shared.btn, shared["btn-sm"])}
                                            onClick={() => onBrowseVolume(e)}
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

function ComposeTab({ app, onSaved, onUp }: { app: App; onSaved: () => void; onUp: () => void }) {
    const composePath = `${app.dir}/${app.composeFile}`;
    const [original, setOriginal] = useState<string | null>(null);
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [mode, setMode] = useState<"visual" | "yaml">("visual");

    useEffect(() => {
        let alive = true;
        setOriginal(null);
        api("readFile", { serverId: app.hostId, path: composePath })
            .then((f) => { if (alive) { setOriginal(f.content); setValue(f.content); } })
            .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
        return () => { alive = false; };
    }, [app.hostId, composePath]);

    const dirty = original !== null && value !== original;

    async function save(andUp: boolean) {
        setSaving(true);
        setError(null);
        try {
            await api("writeFile", { serverId: app.hostId, path: composePath, content: value });
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
                    <ComposeVisualEditor value={value} onChange={setValue} hostId={app.hostId} appDir={app.dir} />
                ) : (
                    <CodeEditor path={composePath} value={value} onChange={setValue} onSave={() => void save(false)} />
                )}
            </div>
            <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", background: "var(--panel-2)", color: "var(--muted)", fontSize: 12 }}>
                Saving writes the file on <b>{app.hostId}</b> only — it does not restart anything. Use <b>Save &amp; up</b> to apply.
            </div>
        </div>
    );
}

// ---- Volumes --------------------------------------------------------------------

function VolumesTab({ app, initial }: { app: App; initial: { path: string; file: string | null } | null }) {
    const [path, setPath] = useState(initial?.path ?? `${app.dir}/volumes`);
    const [file, setFile] = useState<string | null>(initial?.file ?? null);

    return (
        <FilesView
            serverId={app.hostId}
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

// ---- Controls -------------------------------------------------------------------

function ControlsTab({ app, host, status, busy, run, onDeleted }: {
    app: App;
    host: ServerEntry | undefined;
    status: AppStatus | null;
    busy: string | null;
    run: (action: "up" | "restart" | "stop" | "down", opts?: { pullFirst?: boolean; autoOpenModal?: boolean; service?: string }) => void;
    onDeleted: () => void;
}) {
    const [deleting, setDeleting] = useState(false);
    const actions: Array<{ id: string; title: string; subtitle: string; danger?: boolean; primary?: boolean; onRun: () => void }> = [
        { id: "up", title: "Start", subtitle: "docker_compose_action · up", onRun: () => run("up") },
        { id: "restart", title: "Restart", subtitle: "docker_compose_action · restart", onRun: () => run("restart") },
        { id: "stop", title: "Stop", subtitle: "containers stay defined", onRun: () => run("stop") },
        { id: "pull", title: "Pull & up", subtitle: "docker_compose_action · pull first", primary: true, onRun: () => run("up", { pullFirst: true, autoOpenModal: true }) },
        {
            id: "down", title: "Down", subtitle: "removes containers · volumes/ untouched", danger: true,
            onRun: () => { if (confirm(`Take down "${app.name}"? Containers are removed; volumes/ is untouched.`)) run("down"); },
        },
    ];

    return (
        <>
            <section className={shared.panel}>
                <h3>Stack actions</h3>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 10 }}>
                    {actions.map((a) => (
                        <div
                            key={a.id}
                            style={{
                                display: "flex", alignItems: "center", gap: 12, borderRadius: 6, padding: "10px 12px",
                                border: a.danger ? "1px solid color-mix(in srgb, var(--err) 40%, var(--border))" : "1px solid var(--border)",
                            }}
                        >
                            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginRight: "auto" }}>
                                <span style={{ fontWeight: 600, color: a.danger ? "var(--err)" : undefined }}>{a.title}</span>
                                <span className={shared.dim} style={{ fontSize: 12 }}>{a.subtitle}</span>
                            </div>
                            <button
                                className={cx(shared.btn, a.primary && shared["btn-primary"], a.danger && shared["btn-danger"])}
                                disabled={busy !== null}
                                onClick={a.onRun}
                            >
                                {busy === a.id ? "Running…" : "Run"}
                            </button>
                        </div>
                    ))}
                </div>
                {status && status.status === "down" && (
                    <p className={shared.dim} style={{ fontSize: 12, marginTop: 10 }}>This app has no running containers yet.</p>
                )}
            </section>
            {status && status.services.length > 0 && (
                <section className={shared.panel} style={{ marginTop: 14 }}>
                    <h3>Per-service actions</h3>
                    <table className={shared["data-table"]}>
                        <thead>
                            <tr><th>Service</th><th>State</th><th /></tr>
                        </thead>
                        <tbody>
                            {status.services.map((s) => (
                                <tr key={s.name}>
                                    <td style={{ fontWeight: 600 }}>{s.name}</td>
                                    <td><span className={cx(shared.badge, s.up ? shared["badge-ok"] : shared["badge-muted"])}>{s.state ?? "down"}</span></td>
                                    <td>
                                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                                            {s.up ? (
                                                <button
                                                    className={cx(shared.btn, shared["btn-sm"], shared["btn-danger"])}
                                                    disabled={busy !== null}
                                                    onClick={() => { if (confirm(`Take down service "${s.name}"? Its container is removed; the rest of the app is untouched.`)) run("down", { service: s.name }); }}
                                                >
                                                    {busy === `${s.name}:down` ? "…" : "Down"}
                                                </button>
                                            ) : (
                                                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy !== null} onClick={() => run("up", { service: s.name })}>
                                                    {busy === `${s.name}:up` ? "…" : "Up"}
                                                </button>
                                            )}
                                            <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy !== null} onClick={() => run("restart", { service: s.name })}>
                                                {busy === `${s.name}:restart` ? "…" : "Restart"}
                                            </button>
                                            <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy !== null} onClick={() => run("stop", { service: s.name })}>
                                                {busy === `${s.name}:stop` ? "…" : "Stop"}
                                            </button>
                                            <button
                                                className={cx(shared.btn, shared["btn-sm"])}
                                                disabled={busy !== null}
                                                onClick={() => run("up", { pullFirst: true, service: s.name, autoOpenModal: true })}
                                            >
                                                {busy === `${s.name}:up` ? "…" : "Pull"}
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}
            <section className={shared.panel} style={{ marginTop: 14, border: "1px solid color-mix(in srgb, var(--err) 40%, var(--border))" }}>
                <h3>Danger zone</h3>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, marginRight: "auto" }}>
                        <span style={{ fontWeight: 600, color: "var(--err)" }}>Remove app</span>
                        <span className={shared.dim} style={{ fontSize: 12 }}>Unregisters this app from Server Central — folder can be kept or deleted.</span>
                    </div>
                    <button className={cx(shared.btn, shared["btn-danger"])} onClick={() => setDeleting(true)}>
                        Remove…
                    </button>
                </div>
            </section>
            {deleting && (
                <DeleteAppModal app={app} host={host} onClose={() => setDeleting(false)} onDeleted={onDeleted} />
            )}
        </>
    );
}

// ---- Logs -----------------------------------------------------------------------

function LogsTab({ app, status }: { app: App; status: AppStatus | null }) {
    const [service, setService] = useState("");
    const [tail, setTail] = useState(500);
    const [logs, setLogs] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const { logs: text } = await api("getAppLogs", { appId: app.id, service: service || undefined, tail });
            setLogs(text);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [app.id, service, tail]);

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
