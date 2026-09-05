// ---- Host dashboards -------------------------------------------------------------
//
// The per-host overview is a list of widget *instances* the operator arranged.
// Which widgets exist, what they render and what their config means all live in
// the frontend registry (apps/web/src/dashboard) — see doc/idea_host_dashboard.md
// §1 for why that isn't a wire format. Only the arrangement crosses the wire.

/** Columns a card spans in the overview's three-column flow. */
export type WidgetSpan = 1 | 2 | 3;

export const WIDGET_SPANS: readonly WidgetSpan[] = [1, 2, 3];

export interface DashboardWidgetInstance {
    /** Per-instance id, so two cards of the same widget stay distinct — a
     *  dashboard may hold "stack: jellyfin" and "stack: immich" at once. */
    id: string;
    /** `DashboardWidget.id` from the frontend registry, e.g. "docker.stacks".
     *  An id no build knows renders as a placeholder rather than vanishing, so
     *  downgrading doesn't silently eat someone's layout. */
    widget: string;
    span: WidgetSpan;
    /**
     * Widget-defined settings, opaque to the control plane: it validates size
     * and shape, never meaning. Teaching the server each widget's schema would
     * drag half of every feature's frontend into this package.
     */
    config?: Record<string, unknown>;
}

export interface HostDashboard {
    hostId: string;
    /** Render order, top-left first. */
    widgets: DashboardWidgetInstance[];
    updatedAt: number;
}

/** Cards one dashboard may hold, and the serialized size one card's config may
 *  reach. Both exist so a malformed or hostile client can't grow the state file
 *  without bound; neither is a limit a real layout comes near. */
export const DASHBOARD_MAX_WIDGETS = 40;
export const DASHBOARD_MAX_CONFIG_BYTES = 4096;


/**
 * `getHostDashboard` returning `null` means this host has never been
 * customized: the client builds the default from its widget registry, which is
 * also how a widget added in a later release reaches every uncustomized host.
 * See doc/idea_host_dashboard.md §3.
 */
export interface DashboardOperations {
    get: { data: { hostId: string }; response: HostDashboard | null };
    set: { data: { hostId: string; widgets: DashboardWidgetInstance[] }; response: HostDashboard };
    /** Drop the stored arrangement, returning the host to the registry default. */
    reset: { data: { hostId: string }; response: void };
}
