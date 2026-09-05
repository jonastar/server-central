import { useEffect, useMemo, useState } from "react";
import type { DashboardWidgetInstance, ServerEntry, WidgetSpan } from "@central/shared";
import { WIDGET_SPANS } from "@central/shared";
import { api } from "../api";
import { cx } from "../utils";
import { EmptyState, ErrorBanner, Modal } from "../components/ui";
import { defaultLayout, findWidget, instanceFor, widgetAvailable, WIDGETS } from "./registry";
import { WidgetBoundary } from "./WidgetBoundary";
import type { AnyDashboardWidget, WidgetConfig } from "./types";
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
 */

interface CardProps {
    instance: DashboardWidgetInstance;
    widget: AnyDashboardWidget | undefined;
    entry: ServerEntry;
    editing: boolean;
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
                <h3 className={styles["card-title"]}>{widget?.title ?? instance.widget}</h3>
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
                {Body
                    ? (
                        <WidgetBoundary title={widget?.title ?? instance.widget}>
                            <Body serverId={entry.id} entry={entry} config={config} />
                        </WidgetBoundary>
                    )
                    // A layout saved by a newer build, viewed after a downgrade.
                    // Held rather than dropped, so saving here doesn't destroy it.
                    : <div className={styles.placeholder}>Unknown widget "{instance.widget}" — this build doesn't have it.</div>}
            </div>
        </section>
    );
}

function AddWidgetModal({ entry, onAdd, onClose }: {
    entry: ServerEntry;
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
                    <h4>{featureId}</h4>
                    {widgets.map((widget) => {
                        const available = widgetAvailable(widget, entry);
                        return (
                            <button
                                key={widget.id}
                                type="button"
                                className={styles["palette-item"]}
                                disabled={!available}
                                title={available ? undefined : `This host reported ${widget.requires} unavailable`}
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

export function HostDashboard({ entry }: { entry: ServerEntry }) {
    const serverId = entry.id;
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
                    setLayout(stored ? stored.widgets : defaultLayout(entry));
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
            setLayout(defaultLayout(entry));
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

            {entry.status.state === "error" && (
                <ErrorBanner>Connection failed: {entry.status.error}</ErrorBanner>
            )}
            {error && <ErrorBanner>{error}</ErrorBanner>}

            {layout === null
                ? <EmptyState>Loading dashboard…</EmptyState>
                : layout.length === 0
                ? <EmptyState>This dashboard is empty — add a widget, or reset it to the default layout.</EmptyState>
                : (
                    <div className={styles.grid} onDragLeave={() => setOverId(null)}>
                        {layout.map((instance) => (
                            <Card
                                key={instance.id}
                                instance={instance}
                                widget={findWidget(instance.widget)}
                                entry={entry}
                                editing={editing}
                                dragging={dragId === instance.id}
                                dropTarget={editing && overId === instance.id && dragId !== null && dragId !== instance.id}
                                onSpan={(span) => patch(instance.id, { span })}
                                onRemove={() => setLayout((current) => (current ?? []).filter((w) => w.id !== instance.id))}
                                onConfigure={() => setConfiguring(instance.id)}
                                onDragStart={() => setDragId(instance.id)}
                                onDragEnd={() => { setDragId(null); setOverId(null); }}
                                onDragOver={() => reorder(instance.id)}
                            />
                        ))}
                    </div>
                )}

            {adding && (
                <AddWidgetModal
                    entry={entry}
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
