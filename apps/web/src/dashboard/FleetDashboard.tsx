import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { FleetHostSummary, MetricsSnapshot, ProxyRoute, ServerEntry, TaskRun } from "@central/shared";
import type { Route, ServerTab } from "../routes";
import { cx, fmtKb, fmtPct, fmtRate, fmtRelative, fmtUptime, isAgentOutdated, type Tone } from "../utils";
import { fmtDuration, serverLabel, specSummary, statusTone } from "../taskFormat";
import { useCan } from "../hooks/usePermissions";
import { Sparkline, UsageBar } from "../components/charts";
import { EmptyState, ToneDot } from "../components/ui";
import { useHostPoll } from "./useHostPoll";
import { AttentionStrip } from "./AttentionStrip";
import { collectHostIssues, DISK_ERR_PCT, DISK_WARN_PCT, TONE_RANK, usedPct as pct, worstTone, type HostIssue } from "./issues";
import styles from "./FleetDashboard.module.css";
import shared from "../styles/shared.module.css";

/**
 * The fleet overview: what's wrong first, then the totals, then a card (or a
 * row) per host, then the fleet-scoped panels the per-host pages can't show.
 *
 * Live metrics and connection state come off the events socket via props;
 * everything a host's *features* know — stacks, failed units, pool health —
 * arrives as one `dashboard.fleetSummary` poll, collected server-side so the
 * browser isn't asking three namespaces per host every ten seconds. Tasks and
 * the proxy are their own polls, made only when the user may see them.
 *
 * Fixed layout, deliberately: the per-host overview is a widget grid, and this
 * page will become one too (doc/idea_host_dashboard.md §4) once the sections
 * below have proven which of them anyone actually rearranges.
 */

type Density = "cards" | "table";

const DENSITY_KEY = "sc.fleet.density";
const WINDOW_MS = 15 * 60_000;

interface HostView {
    entry: ServerEntry;
    online: boolean;
    history: MetricsSnapshot[];
    latest: MetricsSnapshot | undefined;
    /** Undefined while the summary hasn't arrived, the host is offline, or the
     *  user may not see it. */
    summary: FleetHostSummary | undefined;
    outdated: boolean;
}

/** A host's issue, tagged with the host so the strip can say whose it is. */
interface Issue extends HostIssue {
    host: HostView;
    hostName: string;
}

function tabRoute(host: HostView, tab: ServerTab, extra: Partial<Extract<Route, { view: "server" }>> = {}): Route {
    return { view: "server", serverId: host.entry.id, tab, ...extra };
}

function fullest(disks: MetricsSnapshot["disks"]): MetricsSnapshot["disks"][number] | null {
    return disks.reduce<MetricsSnapshot["disks"][number] | null>(
        (acc, d) => (!acc || d.usedKb / d.totalKb > acc.usedKb / acc.totalKb ? d : acc),
        null,
    );
}

function collectIssues(hosts: HostView[]): Issue[] {
    return hosts
        .flatMap((host) => collectHostIssues(host.entry, host.latest, host.summary, host.outdated).map((i) => ({ ...i, host, hostName: host.entry.name })))
        .sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
}

// ---- Fleet totals ------------------------------------------------------------------

function Tile({ label, value, detail, tone, children }: { label: string; value: ReactNode; detail?: ReactNode; tone?: Tone; children?: ReactNode }) {
    return (
        <div className={cx(styles.tile, tone && styles[`tile-${tone}`])}>
            <div className={styles["tile-label"]}>{label}</div>
            <div className={styles["tile-value"]}>{value}</div>
            {detail && <div className={styles["tile-detail"]}>{detail}</div>}
            {children}
        </div>
    );
}

function Ratio({ n, of }: { n: number; of: number }) {
    return <>{n}<span className={styles["tile-of"]}>/{of}</span></>;
}

function FleetTotals({ hosts, tasks, summaryKnown }: { hosts: HostView[]; tasks: TaskRun[] | null; summaryKnown: boolean }) {
    const online = hosts.filter((h) => h.online);
    const down = hosts.length - online.length;
    const withDocker = online.filter((h) => h.summary?.docker);
    const containers = withDocker.reduce(
        (acc, h) => ({ running: acc.running + h.summary!.docker!.containersRunning, total: acc.total + h.summary!.docker!.containersTotal, completed: acc.completed + h.summary!.docker!.containersCompleted }),
        { running: 0, total: 0, completed: 0 },
    );
    // Finished one-shots are in `total` but not "not running": nothing to bring back.
    const containersDown = containers.total - containers.running - containers.completed;
    const stacks = withDocker.flatMap((h) => h.summary!.docker!.stacks);
    const stacksUp = stacks.filter((s) => s.status === "running").length;
    const stacksDegraded = stacks.filter((s) => s.status === "partial").length;
    const stacksStopped = stacks.length - stacksUp - stacksDegraded;
    const memTotal = online.reduce((n, h) => n + (h.latest?.memory.totalKb ?? 0), 0);
    const memUsed = online.reduce((n, h) => n + (h.latest?.memory.usedKb ?? 0), 0);
    const sampled = online.filter((h) => h.latest);
    const cpuAvg = sampled.length ? sampled.reduce((n, h) => n + h.latest!.cpu.total, 0) / sampled.length : 0;
    const now = Date.now();
    const failedTasks = tasks?.filter((t) => t.status === "failed" && t.finishedAt && now - t.finishedAt < 86_400_000).length ?? 0;
    const runningTasks = tasks?.filter((t) => t.status === "running").length ?? 0;

    // Fleet CPU trend: the average across hosts at each sample slot. Hosts
    // sample on the same cadence, so aligning by index is close enough for a
    // trend line; it isn't a chart anyone reads values off.
    const cpuLine = useMemo(() => {
        const ref = sampled.reduce<MetricsSnapshot[]>((best, h) => (h.history.length > best.length ? h.history : best), []);
        return ref.map((s, i) => {
            const vals = sampled.map((h) => h.history[h.history.length - ref.length + i]?.cpu.total).filter((v): v is number => v !== undefined);
            return { ts: s.ts, v: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0 };
        });
    }, [sampled]);

    const pending = !summaryKnown && online.length > 0;
    return (
        <div className={styles.tiles}>
            <Tile label="Hosts" value={<Ratio n={online.length} of={hosts.length} />}
                detail={down > 0 ? `${down} not reachable` : "all online"} tone={down > 0 ? "err" : undefined} />
            <Tile label="Containers" value={pending ? "…" : <Ratio n={containers.running} of={containers.total} />}
                detail={pending ? "" : [containersDown > 0 && `${containersDown} not running`, containers.completed > 0 && `${containers.completed} completed`].filter(Boolean).join(" · ") || "all running"} />
            <Tile label="Stacks" value={pending ? "…" : <Ratio n={stacksUp} of={stacks.length} />}
                detail={pending ? "" : [stacksDegraded && `${stacksDegraded} degraded`, stacksStopped && `${stacksStopped} stopped`].filter(Boolean).join(" · ") || "all up"}
                tone={!pending && stacksDegraded > 0 ? "warn" : undefined} />
            <Tile label="CPU" value={fmtPct(cpuAvg)} detail="fleet average">
                <Sparkline points={cpuLine} className={styles["tile-spark"]} height={22} windowMs={WINDOW_MS} fmt={fmtPct} />
            </Tile>
            <Tile label="Memory" value={fmtPct(pct(memUsed, memTotal))} detail={`${fmtKb(memUsed)} of ${fmtKb(memTotal)}`} />
            {/* A count, not an alarm: a failed run stays failed after it's been
                dealt with, so colouring it would nag about solved problems. */}
            {tasks && (
                <Tile label="Tasks" value={runningTasks || failedTasks}
                    detail={runningTasks ? `running now${failedTasks ? ` · ${failedTasks} failed in 24 h` : ""}` : failedTasks ? "failed in 24 h" : "no failures in 24 h"} />
            )}
        </div>
    );
}

// ---- Hosts -----------------------------------------------------------------------------

function hostIssues(host: HostView, issues: Issue[]): Issue[] {
    return issues.filter((i) => i.host === host && i.tone !== "muted");
}

function hostTone(host: HostView, issues: Issue[]): Tone {
    return host.online ? worstTone(hostIssues(host, issues)) : "err";
}

function HostCard({ host, issues, onNavigate }: { host: HostView; issues: Issue[]; onNavigate(route: Route): void }) {
    const { entry, latest, summary } = host;
    const info = entry.status.info;
    const own = hostIssues(host, issues);
    const tone = hostTone(host, issues);
    const hotDisks = (latest?.disks ?? []).filter((d) => pct(d.usedKb, d.totalKb) >= DISK_WARN_PCT);
    const shownDisks = hotDisks.length > 0 ? hotDisks : latest ? [fullest(latest.disks)].filter((d): d is NonNullable<typeof d> => d !== null) : [];
    const uptime = info ? info.uptimeSeconds + (Date.now() - info.capturedAt) / 1000 : null;
    const stacks = summary?.docker?.stacks ?? [];
    const stacksUp = stacks.filter((s) => s.status === "running").length;
    const stacksDegraded = stacks.filter((s) => s.status === "partial").length;
    const badPool = summary?.pools?.find((p) => p.state !== "ONLINE");
    const go = (route: Route) => onNavigate(route);

    return (
        <article className={cx(styles.host, styles[`host-${tone}`], !host.online && styles["host-down"])} onClick={() => go(tabRoute(host, "overview"))}>
            <header className={styles["host-head"]}>
                <span className={styles["host-name"]}>{entry.name}</span>
                {host.outdated && <span className={cx(shared.badge, shared["badge-muted"])} title={`Agent ${info?.agentVersion} — update available`}>↑ agent</span>}
                <span className={styles["host-ip"]}>{info?.primaryIp ?? ""}</span>
            </header>
            <div className={styles["host-sub"]}>
                {host.online && info
                    ? <>{info.os} · up {fmtUptime(uptime!)}</>
                    : entry.status.state === "offline"
                    ? <span className={styles["host-state-err"]}>Offline{entry.status.lastSeenAt ? ` · last seen ${fmtRelative(entry.status.lastSeenAt)}` : ""}</span>
                    : entry.status.state === "error"
                    ? <span className={styles["host-state-err"]}>Error · {entry.status.error}</span>
                    : <span className={shared.dim}>{entry.status.state}</span>}
            </div>

            {latest
                ? (
                    <div className={styles["host-metrics"]}>
                        <div className={styles["host-row"]}>
                            <span className={styles["host-label"]}>CPU</span>
                            <Sparkline points={host.history.map((s) => ({ ts: s.ts, v: s.cpu.total }))} className={styles["host-spark"]} windowMs={WINDOW_MS} fmt={fmtPct} />
                            <b className={styles["host-num"]}>{fmtPct(latest.cpu.total)}</b>
                        </div>
                        <UsageBar label="Mem" pct={pct(latest.memory.usedKb, latest.memory.totalKb)} detail={`${fmtKb(latest.memory.usedKb)} / ${fmtKb(latest.memory.totalKb)}`} />
                        {/* Every disk past the threshold gets a bar; otherwise just the fullest one. */}
                        {shownDisks.map((d) => (
                            <UsageBar key={d.mount} label={d.mount} pct={pct(d.usedKb, d.totalKb)} detail={`${fmtKb(d.usedKb)} / ${fmtKb(d.totalKb)}`} />
                        ))}
                        <div className={cx(styles["host-row"], styles["host-net"])}>
                            <span className={styles["host-label"]}>Net</span>
                            <span>↓ {fmtRate(latest.network.rxBytesPerSec)}</span>
                            <span>↑ {fmtRate(latest.network.txBytesPerSec)}</span>
                        </div>
                    </div>
                )
                : host.online && <div className={styles["host-pending"]}>Collecting metrics…</div>}

            {host.online && summary && (
                <footer className={styles["host-chips"]} onClick={(e) => e.stopPropagation()}>
                    {summary.docker && (
                        <>
                            <button className={styles.chip} onClick={() => go(tabRoute(host, "docker", { section: "containers" }))} title="Containers running / total">
                                <span className={styles["chip-num"]}>{summary.docker.containersRunning}<span className={styles["chip-of"]}>/{summary.docker.containersTotal}</span></span> containers
                            </button>
                            {/* "Up" means every container running, so a degraded stack
                                isn't up — but "0/1 stacks" for a stack with 8 of 9
                                containers running reads as an outage. Name the
                                degradation instead; the ratio is only shown when the
                                non-up stacks are actually stopped. */}
                            {stacksDegraded > 0
                                ? (
                                    <button className={cx(styles.chip, styles["chip-warn"])} onClick={() => go(tabRoute(host, "docker", { section: "stacks" }))} title="Stacks with only some containers running">
                                        <span className={styles["chip-num"]}>{stacksDegraded}</span> stack{stacksDegraded === 1 ? "" : "s"} degraded
                                    </button>
                                )
                                : stacks.length > 0 && (
                                    <button className={styles.chip} onClick={() => go(tabRoute(host, "docker", { section: "stacks" }))} title="Stacks running / total">
                                        <span className={styles["chip-num"]}>{stacksUp}<span className={styles["chip-of"]}>/{stacks.length}</span></span> stacks
                                    </button>
                                )}
                        </>
                    )}
                    {!!summary.failedUnits?.length && (
                        <button className={cx(styles.chip, styles["chip-warn"])} onClick={() => go(tabRoute(host, "services"))}>
                            <span className={styles["chip-num"]}>{summary.failedUnits.length}</span> failed unit{summary.failedUnits.length === 1 ? "" : "s"}
                        </button>
                    )}
                    {badPool && (
                        <button className={cx(styles.chip, styles["chip-err"])} onClick={() => go(tabRoute(host, "zfs"))}>
                            pool {badPool.state.toLowerCase()}
                        </button>
                    )}
                    {own.length === 0 && <span className={styles["chip-ok"]}>✓ healthy</span>}
                </footer>
            )}
        </article>
    );
}

function HostTable({ hosts, issues, onNavigate }: { hosts: HostView[]; issues: Issue[]; onNavigate(route: Route): void }) {
    return (
        <div className={styles["table-wrap"]}>
            <table className={cx(shared["data-table"], styles.table)}>
                <thead>
                    <tr>
                        <th>Host</th>
                        <th>Status</th>
                        <th>CPU</th>
                        <th>Memory</th>
                        <th>Disk</th>
                        <th>Net</th>
                        <th className={styles["th-num"]}>Containers</th>
                        <th className={styles["th-num"]}>Stacks</th>
                        <th>Issues</th>
                    </tr>
                </thead>
                <tbody>
                    {hosts.map((host) => {
                        const { entry, latest, summary } = host;
                        const info = entry.status.info;
                        const own = hostIssues(host, issues);
                        const tone = hostTone(host, issues);
                        const worstDisk = latest ? fullest(latest.disks) : null;
                        const stacks = summary?.docker?.stacks ?? [];
                        const uptime = info ? info.uptimeSeconds + (Date.now() - info.capturedAt) / 1000 : null;
                        return (
                            <tr key={entry.id} className={shared["row-clickable"]} onClick={() => onNavigate(tabRoute(host, "overview"))}>
                                <td>
                                    <div className={styles["cell-host"]}>
                                        <span className={styles["host-name"]}>{entry.name}</span>
                                        <span className={styles["host-ip"]}>{info?.primaryIp ?? ""}</span>
                                    </div>
                                </td>
                                <td>
                                    <span className={styles["cell-status"]}>
                                        <ToneDot tone={host.online ? "ok" : "err"} />
                                        {host.online && uptime !== null ? `up ${fmtUptime(uptime)}` : entry.status.state}
                                    </span>
                                </td>
                                <td>
                                    {latest && (
                                        <span className={styles["cell-spark"]}>
                                            <Sparkline points={host.history.map((s) => ({ ts: s.ts, v: s.cpu.total }))} height={20} windowMs={WINDOW_MS} />
                                            <b className={styles["host-num"]}>{fmtPct(latest.cpu.total)}</b>
                                        </span>
                                    )}
                                </td>
                                <td>{latest && <MiniBar pct={pct(latest.memory.usedKb, latest.memory.totalKb)} />}</td>
                                <td>{worstDisk && <MiniBar pct={pct(worstDisk.usedKb, worstDisk.totalKb)} label={worstDisk.mount} />}</td>
                                <td className={shared.dim}>{latest && <>↓ {fmtRate(latest.network.rxBytesPerSec)} ↑ {fmtRate(latest.network.txBytesPerSec)}</>}</td>
                                <td className={styles["td-num"]}>{summary?.docker && <>{summary.docker.containersRunning}<span className={styles["chip-of"]}>/{summary.docker.containersTotal}</span></>}</td>
                                <td className={styles["td-num"]}>{summary?.docker && stacks.length > 0 && <>{stacks.filter((s) => s.status === "running").length}<span className={styles["chip-of"]}>/{stacks.length}</span></>}</td>
                                <td>
                                    {own.length > 0
                                        ? <span className={cx(shared.badge, shared[`badge-${tone === "ok" ? "muted" : tone}`])}>{own.length} issue{own.length === 1 ? "" : "s"}</span>
                                        : host.online ? <span className={shared.dim}>—</span> : null}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

function MiniBar({ pct: value, label }: { pct: number; label?: string }) {
    const tone = value >= DISK_ERR_PCT ? "err" : value >= DISK_WARN_PCT ? "warn" : "ok";
    return (
        <span className={styles.minibar} title={label}>
            <span className={styles["minibar-track"]}>
                <span className={cx(styles["minibar-fill"], styles[`minibar-${tone}`])} style={{ width: `${Math.min(100, value)}%` }} />
            </span>
            <span className={styles["minibar-text"]}>{fmtPct(value)}{label && <span className={shared.dim}> {label}</span>}</span>
        </span>
    );
}

// ---- Fleet panels ----------------------------------------------------------------------

function Panel({ title, meta, children, action }: { title: string; meta?: ReactNode; children: ReactNode; action?: ReactNode }) {
    return (
        <section className={cx(shared.panel, styles.panel)}>
            <div className={shared["panel-head"]}>
                <h3>{title}</h3>
                {meta && <span className={styles["panel-meta"]}>{meta}</span>}
                {action}
            </div>
            {children}
        </section>
    );
}

function RecentTasks({ tasks, servers, onNavigate }: { tasks: TaskRun[]; servers: ServerEntry[]; onNavigate(route: Route): void }) {
    return (
        <Panel title="Recent tasks" action={<button className={styles["panel-link"]} onClick={() => onNavigate({ view: "tasks" })}>All tasks →</button>}>
            {tasks.length === 0
                ? <div className={styles["panel-ok"]}>No task has run yet.</div>
                : (
                    <ul className={styles.rows}>
                        {tasks.slice(0, 6).map((t) => (
                            <li key={t.id} className={styles.row}>
                                <ToneDot tone={statusTone(t.status)} />
                                <span className={styles["row-title"]}>{specSummary(t.spec)}</span>
                                <span className={styles["row-host"]}>{serverLabel(t.target, servers)}</span>
                                <span className={cx(styles["row-meta"], t.status === "running" && styles["row-running"])}>
                                    {t.status === "running" ? "running" : t.finishedAt ? `${fmtRelative(t.finishedAt)} · ${fmtDuration(t)}` : t.status}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
        </Panel>
    );
}

function routeTarget(route: ProxyRoute, servers: ServerEntry[]): string {
    const node = serverLabel(route.target.nodeId, servers);
    return route.target.kind === "hostPort" ? `${node}:${route.target.port}` : `${node} · ${route.target.service}`;
}

function ProxyPanel({ servers, onNavigate }: { servers: ServerEntry[]; onNavigate(route: Route): void }) {
    const { data, error } = useHostPoll("proxy", "getState", undefined);
    const open = <button className={styles["panel-link"]} onClick={() => onNavigate({ view: "proxy" })}>Open →</button>;
    if (error) {
        return <Panel title="Proxy" action={open}><div className={styles["panel-ok"]}><ToneDot tone="err" /> {error}</div></Panel>;
    }
    if (!data) {
        return <Panel title="Proxy" action={open}><div className={styles["panel-ok"]}>Loading…</div></Panel>;
    }
    if (!data.config) {
        return <Panel title="Proxy" action={open}><div className={styles["panel-ok"]}><ToneDot tone="muted" /> Not set up.</div></Panel>;
    }
    const on = data.routes.filter((r) => r.enabled);
    const container = data.container;
    const containerTone: Tone = !container ? "muted" : container.deploying ? "muted" : container.present && container.state === "running" ? "ok" : "err";
    const containerText = !container
        ? "status unknown"
        : container.deploying ? "deploying…"
        : !container.present ? `not running on ${serverLabel(data.config.nodeId, servers)}${container.error ? ` — ${container.error}` : ""}`
        : `${container.status ?? container.state} on ${serverLabel(data.config.nodeId, servers)}`;
    const apply = data.lastApply;
    return (
        <Panel title="Proxy" meta={`${on.length} of ${data.routes.length} routes on`} action={open}>
            <ul className={styles.rows}>
                <li className={styles.row}>
                    <ToneDot tone={containerTone} />
                    <span className={styles["row-title"]}>Caddy</span>
                    <span className={styles["row-meta"]}>{containerText}</span>
                </li>
                {apply && (
                    <li className={styles.row}>
                        <ToneDot tone={apply.ok ? "ok" : "err"} />
                        <span className={styles["row-title"]}>Last apply</span>
                        <span className={cx(styles["row-meta"], !apply.ok && styles["row-meta-bad"])}>{apply.ok ? fmtRelative(apply.at) : apply.error ?? "failed"}</span>
                    </li>
                )}
            </ul>
            {on.length > 0 && (
                <div className={styles["route-list"]}>
                    {on.map((r) => (
                        <span key={r.id} className={styles["route-pill"]} title={`→ ${routeTarget(r, servers)}`}>
                            {r.host}{r.pathPrefix ?? ""}
                        </span>
                    ))}
                </div>
            )}
        </Panel>
    );
}

function StoragePanel({ hosts }: { hosts: HostView[] }) {
    const pools = hosts.flatMap((h) => (h.summary?.pools ?? []).map((pool) => ({ host: h, pool })));
    if (pools.length === 0) {
        return null;
    }
    return (
        <Panel title="Storage" meta={`${pools.length} pool${pools.length === 1 ? "" : "s"}`}>
            <ul className={styles.rows}>
                {pools.map(({ host, pool }) => (
                    <li key={`${host.entry.id}/${pool.name}`} className={cx(styles.row, styles["row-stack"])}>
                        <div className={styles["row-line"]}>
                            <ToneDot tone={pool.state === "ONLINE" ? "ok" : pool.state === "DEGRADED" ? "warn" : "err"} />
                            <span className={styles["row-title"]}>{pool.name}</span>
                            <span className={styles["row-host"]}>{host.entry.name}</span>
                            <span className={cx(styles["row-meta"], pool.state !== "ONLINE" && styles["row-meta-bad"])}>
                                {pool.state !== "ONLINE"
                                    ? pool.state
                                    : pool.scrubInProgress ? "scrubbing"
                                    : pool.lastScrubAt === null ? "never scrubbed"
                                    : `scrub ${fmtRelative(pool.lastScrubAt)}`}
                            </span>
                        </div>
                        <MiniBar pct={pool.capacityPct} />
                    </li>
                ))}
            </ul>
        </Panel>
    );
}

// ---- Page ------------------------------------------------------------------------------

function readDensity(): Density {
    try {
        return localStorage.getItem(DENSITY_KEY) === "table" ? "table" : "cards";
    } catch {
        return "cards";
    }
}

export function FleetDashboard({ servers, metrics, onNavigate }: {
    servers: ServerEntry[];
    metrics: Record<string, MetricsSnapshot[]>;
    onNavigate(route: Route): void;
}) {
    const can = useCan();
    const [density, setDensity] = useState<Density>(readDensity);
    useEffect(() => {
        try {
            localStorage.setItem(DENSITY_KEY, density);
        } catch {
            // Storage blocked: the toggle still works for this page load.
        }
    }, [density]);

    const anyOnline = servers.some((s) => s.status.state === "online");
    const summary = useHostPoll("dashboard", "fleetSummary", undefined, { enabled: anyOnline && can("panel.dashboard.read") });
    const tasks = useHostPoll("tasks", "list", { limit: 20 }, { enabled: can("panel.tasks.read") });
    const canProxy = can("panel.proxy.read");

    const hosts = useMemo<HostView[]>(() => {
        const byId = new Map((summary.data?.hosts ?? []).map((h) => [h.hostId, h]));
        return servers.map((entry) => {
            const history = metrics[entry.id] ?? [];
            return {
                entry,
                online: entry.status.state === "online",
                history,
                latest: history.at(-1),
                summary: byId.get(entry.id),
                outdated: isAgentOutdated(entry),
            };
        });
    }, [servers, metrics, summary.data]);

    const issues = useMemo(() => collectIssues(hosts), [hosts]);

    return (
        <div className={shared.view}>
            <header className={shared["view-header"]}>
                <h1>Dashboard</h1>
                {summary.error && <span className={cx(shared.badge, shared["badge-warn"])} title={summary.error}>summary unavailable</span>}
                <div className={shared.segmented} role="group" aria-label="Density">
                    <button className={cx(shared.segment, density === "cards" && shared["segment-active"])} onClick={() => setDensity("cards")}>Cards</button>
                    <button className={cx(shared.segment, density === "table" && shared["segment-active"])} onClick={() => setDensity("table")}>Table</button>
                </div>
            </header>

            {servers.length === 0
                ? <EmptyState>No agents connected yet.</EmptyState>
                : (
                    <>
                        <AttentionStrip
                            issues={issues}
                            waiting={anyOnline && summary.loading}
                            clearText="Every host is online, every stack is up, nothing is failing."
                            onNavigate={onNavigate}
                        />
                        <FleetTotals hosts={hosts} tasks={tasks.data} summaryKnown={summary.data !== null || summary.error !== null} />

                        {density === "cards"
                            ? (
                                <div className={styles["host-grid"]}>
                                    {hosts.map((host) => (
                                        <HostCard key={host.entry.id} host={host} issues={issues} onNavigate={onNavigate} />
                                    ))}
                                </div>
                            )
                            : <HostTable hosts={hosts} issues={issues} onNavigate={onNavigate} />}

                        <div className={styles["panel-grid"]}>
                            {tasks.data && <RecentTasks tasks={tasks.data} servers={servers} onNavigate={onNavigate} />}
                            {canProxy && <ProxyPanel servers={servers} onNavigate={onNavigate} />}
                            <StoragePanel hosts={hosts} />
                        </div>
                    </>
                )}
        </div>
    );
}
