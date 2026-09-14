import { useEffect, useMemo, useState } from "react";
import type { DashboardWidgetInstance, Permission, ServerEntry, WidgetSpan } from "@central/shared";
import { WIDGET_SPANS } from "@central/shared";
import { api } from "../api";
import type { Route } from "../routes";
import { cx, isAgentOutdated } from "../utils";
import { useCan } from "../hooks/usePermissions";
import { useConnection } from "../hooks/useConnection";
import { EmptyState, ErrorBanner, Modal } from "../components/ui";
import { defaultLayout, FEATURE_NAMES, findWidget, instanceFor, widgetAvailable, widgetPermitted, WIDGETS } from "./registry";
import { WidgetBoundary } from "./WidgetBoundary";
import { AttentionStrip } from "./AttentionStrip";
import { collectHostIssues } from "./issues";
import { useHostPoll } from "./useHostPoll";
import type { AnyDashboardWidget, WidgetConfig, WidgetLink } from "./types";
import styles from "./HostDashboard.module.css";
import shared from "../styles/shared.module.css";

/**
 * A host's overview: whatever cards the features registered, in whatever order
 * someone arranged them.
 *
 * The layout is stored on the control plane per host (not per user, not in
 * localStorage) — it describes the box, not the person looking at it. A host
 * nobody has arranged has no stored row at all and gets `defaultLayout()`
 * computed from the registry, which is what lets a widget added in a later
 * release appear without a migration. See doc/idea_host_dashboard.md.
 *
 * Above the grid sits what isn't a card: the host's own attention strip (the
 * same issue list the fleet page shows, filtered to this host) and the time
 * range every chart on the page shares.
 */

const WINDOW_KEY = "sc.host.window";
const WINDOWS: Array<{ ms: number; label: string }> = [
    { ms: 15 * 60_000, label: "15m" },
    { ms: 30 * 60_000, label: "30m" },
    { ms: 60 * 60_000, label: "1h" },
];

function readWindow(): number {
    try {
        const stored = Number(localStorage.getItem(WINDOW_KEY));
        return WINDOWS.some((w) => w.ms === stored) ? stored : WINDOWS[0].ms;
    } catch {
        return WINDOWS[0].ms;
    }
}

interface CardProps {
    instance: DashboardWidgetInstance;
    widget: AnyDashboardWidget | undefined;
    entry: ServerEntry;
    windowMs: number;
    permitted: boolean;
    editing: boolean;
    onOpen(link: WidgetLink): void;
    onNavigate(route: Route): void;
    dragging: boolean;
    dropTarget: boolean;
    onSpan(span: WidgetSpan): void;
    onRemove(): void;
    onConfigure(): void;
    onDragStart(): void;
    onDragEnd(): void;
    onDragOver(): void;
}

function SpanControl({ widget, span, onSpan }: { widget: AnyDashboardWidget | undefined; span: WidgetSpan; onSpan: (s: WidgetSpan) => void }) {
    const min = widget?.minSpan ?? 1;
    return (
        <div className={styles["span-group"]} title="Columns this card spans">
            {WIDGET_SPANS.map((value) => (
                <button
                    key={value}
                    type="button"
                    className={cx(styles["span-button"], value === span && styles["span-button-active"])}
                    disabled={value < min}
                    onClick={() => onSpan(value)}
                >
                    {value}
                </button>
            ))}
        </div>
    );
}

function Card(props: CardProps) {
    const { instance, widget, entry, editing } = props;
    const config = { ...(widget?.defaultConfig ?? {}), ...(instance.config ?? {}) } as WidgetConfig;
    const label = widget?.label?.(config) ?? null;
    const Body = widget?.component;

    return (
        <section
            className={cx(
                shared.panel,
                styles.card,
                styles[`span-${instance.span}`],
                editing && styles.editable,
                props.dragging && styles.dragging,
                props.dropTarget && styles["drop-target"],
            )}
            draggable={editing}
            onDragStart={props.onDragStart}
            onDragEnd={props.onDragEnd}
            onDragOver={(e) => {
                if (editing) {
                    // Without this the drop is refused and no reorder happens.
                    e.preventDefault();
                    props.onDragOver();
                }
            }}
        >
            <div className={styles["card-head"]}>
                {widget?.link && !editing
                    ? (
                        <h3 className={styles["card-title"]}>
                            <button className={styles["card-title-link"]} title={`Open ${widget.link.tab}`} onClick={() => props.onOpen(widget.link!)}>
                                {widget.title} <span className={styles["card-title-arrow"]}>→</span>
                            </button>
                        </h3>
                    )
                    : <h3 className={styles["card-title"]}>{widget?.title ?? instance.widget}</h3>}
                {label && <span className={styles["card-label"]}>{label}</span>}
                {editing && (
                    <div className={styles["card-tools"]}>
                        <SpanControl widget={widget} span={instance.span} onSpan={props.onSpan} />
                        {widget?.configForm && (
                            <button className={shared["btn-icon"]} title="Widget settings" onClick={props.onConfigure}>⚙</button>
                        )}
                        <button className={shared["btn-icon"]} title="Remove from dashboard" onClick={props.onRemove}>✕</button>
                    </div>
                )}
            </div>
            <div className={styles["card-body"]}>
                {Body && !props.permitted
                    // Kept in the layout (it's shared, and someone else may see
                    // it) but not rendered: its requests would only be refused.
                    ? <div className={styles.placeholder}>You don't have permission to view this.</div>
                    : Body
                    ? (
                        <WidgetBoundary title={widget?.title ?? instance.widget}>
                            <Body serverId={entry.id} entry={entry} config={config} windowMs={props.windowMs} onNavigate={props.onNavigate} />
                        </WidgetBoundary>
                    )
                    // A layout saved by a newer build, viewed after a downgrade.
                    // Held rather than dropped, so saving here doesn't destroy it.
                    : <div className={styles.placeholder}>Unknown widget "{instance.widget}" — this build doesn't have it.</div>}
            </div>
        </section>
    );
}

function AddWidgetModal({ entry, can, onAdd, onClose }: {
    entry: ServerEntry;
    can(permission: Permission): boolean;
    onAdd(widget: AnyDashboardWidget): void;
    onClose(): void;
}) {
    const groups = useMemo(() => {
        const byFeature = new Map<string, AnyDashboardWidget[]>();
        for (const widget of WIDGETS) {
            const list = byFeature.get(widget.featureId) ?? [];
            list.push(widget);
            byFeature.set(widget.featureId, list);
        }
        return [...byFeature.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    }, []);

    return (
        <Modal title="Add widget" onClose={onClose} width={520}>
            {groups.map(([featureId, widgets]) => (
                <div key={featureId} className={styles["palette-group"]}>
                    <h4>{FEATURE_NAMES[featureId] ?? featureId}</h4>
                    {widgets.map((widget) => {
                        const available = widgetAvailable(widget, entry);
                        const permitted = widgetPermitted(widget, can);
                        return (
                            <button
                                key={widget.id}
                                type="button"
                                className={styles["palette-item"]}
                                disabled={!available || !permitted}
                                title={!available ? `This host reported ${widget.requires} unavailable` : !permitted ? "You don't have permission to view this" : undefined}
                                onClick={() => onAdd(widget)}
                            >
                                <div className={styles["palette-title"]}>{widget.title}</div>
                                <div className={styles["palette-desc"]}>{widget.description}</div>
                            </button>
                        );
                    })}
                </div>
            ))}
        </Modal>
    );
}

function ConfigureModal({ instance, widget, entry, onChange, onClose }: {
    instance: DashboardWidgetInstance;
    widget: AnyDashboardWidget;
    entry: ServerEntry;
    onChange(config: WidgetConfig): void;
    onClose(): void;
}) {
    const Form = widget.configForm!;
    const config = { ...(widget.defaultConfig ?? {}), ...(instance.config ?? {}) } as WidgetConfig;
    return (
        <Modal title={`${widget.title} settings`} onClose={onClose} width={420}>
            <Form serverId={entry.id} entry={entry} config={config} onChange={onChange} />
            <div className={cx(shared["modal-actions"], styles.toolbar)}>
                <div className={styles["toolbar-spacer"]} />
                <button className={cx(shared.btn, shared["btn-primary"])} onClick={onClose}>Done</button>
            </div>
        </Modal>
    );
}

export function HostDashboard({ entry, onNavigate }: { entry: ServerEntry; onNavigate(route: Route): void }) {
    const serverId = entry.id;
    const can = useCan();
    const online = entry.status.state === "online";
    const [windowMs, setWindowMs] = useState<number>(readWindow);
    useEffect(() => {
        try {
            localStorage.setItem(WINDOW_KEY, String(windowMs));
        } catch {
            // Storage blocked: the choice still holds for this page load.
        }
    }, [windowMs]);

    // The same digest the fleet page polls, so the two pages share one cache
    // entry and the host's strip agrees with its card over there.
    const summary = useHostPoll("dashboard", "fleetSummary", undefined, { enabled: online && can("panel.dashboard.read") });
    const latest = useConnection().metrics[serverId]?.at(-1);
    const issues = useMemo(
        () => collectHostIssues(entry, latest, summary.data?.hosts.find((h) => h.hostId === serverId), isAgentOutdated(entry)),
        [entry, latest, summary.data, serverId],
    );
    /** null only while the stored layout is still being fetched; the default is
     *  materialized into state on load rather than computed per render, because
     *  `defaultLayout` mints fresh instance ids each call — recomputing it would
     *  rebuild every card's React key on every metrics tick. */
    const [layout, setLayout] = useState<DashboardWidgetInstance[] | null>(null);
    const [editing, setEditing] = useState(false);
    /** The layout as it was when editing started, for Cancel. */
    const [saved, setSaved] = useState<DashboardWidgetInstance[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [adding, setAdding] = useState(false);
    const [configuring, setConfiguring] = useState<string | null>(null);
    const [dragId, setDragId] = useState<string | null>(null);
    const [overId, setOverId] = useState<string | null>(null);

    // `entry` changes identity on every metrics tick, so the load effect keys on
    // the id alone — refetching a layout ten times a minute would be absurd.
    useEffect(() => {
        let cancelled = false;
        setLayout(null);
        setEditing(false);
        setError(null);
        void (async () => {
            try {
                const stored = await api("dashboard", "get", { hostId: serverId });
                if (!cancelled) {
                    // No stored row means nobody has arranged this host: build
                    // the default from the registry. See idea_host_dashboard.md §3.
                    setLayout(stored ? stored.widgets : defaultLayout(entry, can));
                }
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : String(err));
                    setLayout([]);
                }
            }
        })();
        return () => { cancelled = true; };
    }, [serverId]);

    function patch(instanceId: string, change: Partial<DashboardWidgetInstance>) {
        setLayout((current) => (current ?? []).map((w) => (w.id === instanceId ? { ...w, ...change } : w)));
    }

    function startEditing() {
        setSaved(layout ?? []);
        setEditing(true);
        setError(null);
    }

    function cancelEditing() {
        setLayout(saved);
        setEditing(false);
        setError(null);
    }

    async function save() {
        setBusy(true);
        try {
            const stored = await api("dashboard", "set", { hostId: serverId, widgets: layout ?? [] });
            setLayout(stored.widgets);
            setEditing(false);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function resetToDefault() {
        if (!confirm("Reset this host's dashboard to the default layout?")) {
            return;
        }
        setBusy(true);
        try {
            await api("dashboard", "reset", { hostId: serverId });
            setLayout(defaultLayout(entry, can));
            setEditing(false);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    /** Move the dragged card to the position of the one it's hovering. */
    function reorder(targetId: string) {
        setOverId(targetId);
        if (!dragId || dragId === targetId) {
            return;
        }
        setLayout((current) => {
            const list = [...(current ?? [])];
            const from = list.findIndex((w) => w.id === dragId);
            const to = list.findIndex((w) => w.id === targetId);
            if (from < 0 || to < 0) {
                return list;
            }
            const [moved] = list.splice(from, 1);
            list.splice(to, 0, moved);
            return list;
        });
    }

    const configuringInstance = configuring ? (layout ?? []).find((w) => w.id === configuring) : undefined;
    const configuringWidget = configuringInstance ? findWidget(configuringInstance.widget) : undefined;

    return (
        <div className={shared.view}>
            <header className={shared["view-header"]}>
                <h1>{entry.name}</h1>
                <div className={styles.toolbar}>
                    {!editing && (
                        <div className={shared.segmented} role="group" aria-label="Chart time range" title="Time range for every chart on this page">
                            {WINDOWS.map((w) => (
                                <button key={w.ms} className={cx(shared.segment, windowMs === w.ms && shared["segment-active"])} onClick={() => setWindowMs(w.ms)}>
                                    {w.label}
                                </button>
                            ))}
                        </div>
                    )}
                    {editing
                        ? (
                            <>
                                <button className={shared.btn} onClick={() => setAdding(true)}>Add widget</button>
                                <button className={shared.btn} onClick={() => void resetToDefault()} disabled={busy}>Reset to default</button>
                                <button className={shared.btn} onClick={cancelEditing} disabled={busy}>Cancel</button>
                                <button className={cx(shared.btn, shared["btn-primary"])} onClick={() => void save()} disabled={busy}>
                                    {busy ? "Saving…" : "Save layout"}
                                </button>
                            </>
                        )
                        : <button className={shared.btn} onClick={startEditing} disabled={layout === null}>Edit layout</button>}
                </div>
            </header>

            <AttentionStrip
                issues={issues}
                waiting={online && summary.loading}
                clearText="Every stack is up, nothing is failing."
                onNavigate={onNavigate}
            />
            {error && <ErrorBanner>{error}</ErrorBanner>}

            {layout === null
                ? <EmptyState>Loading dashboard…</EmptyState>
                : layout.length === 0
                ? <EmptyState>This dashboard is empty — add a widget, or reset it to the default layout.</EmptyState>
                : (
                    <div className={styles.grid} onDragLeave={() => setOverId(null)}>
                        {layout.map((instance) => {
                            const widget = findWidget(instance.widget);
                            return (
                                <Card
                                    key={instance.id}
                                    instance={instance}
                                    widget={widget}
                                    entry={entry}
                                    windowMs={windowMs}
                                    permitted={!widget || widgetPermitted(widget, can)}
                                    editing={editing}
                                    onOpen={(link) => onNavigate({ view: "server", serverId, tab: link.tab, section: link.section, zfsSection: link.zfsSection })}
                                    onNavigate={onNavigate}
                                    dragging={dragId === instance.id}
                                    dropTarget={editing && overId === instance.id && dragId !== null && dragId !== instance.id}
                                    onSpan={(span) => patch(instance.id, { span })}
                                    onRemove={() => setLayout((current) => (current ?? []).filter((w) => w.id !== instance.id))}
                                    onConfigure={() => setConfiguring(instance.id)}
                                    onDragStart={() => setDragId(instance.id)}
                                    onDragEnd={() => { setDragId(null); setOverId(null); }}
                                    onDragOver={() => reorder(instance.id)}
                                />
                            );
                        })}
                    </div>
                )}

            {adding && (
                <AddWidgetModal
                    entry={entry}
                    can={can}
                    onAdd={(widget) => {
                        setLayout([...(layout ?? []), instanceFor(widget)]);
                        setAdding(false);
                    }}
                    onClose={() => setAdding(false)}
                />
            )}

            {configuringInstance && configuringWidget?.configForm && (
                <ConfigureModal
                    instance={configuringInstance}
                    widget={configuringWidget}
                    entry={entry}
                    onChange={(config) => patch(configuringInstance.id, { config })}
                    onClose={() => setConfiguring(null)}
                />
            )}
        </div>
    );
}
