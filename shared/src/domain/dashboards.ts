import type { ComposeStackRunStatus } from "./compose";
import type { ZfsHealth } from "./zfs";

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
    /** What the fleet overview shows beyond live metrics — see {@link FleetSummary}. */
    fleetSummary: { data: void; response: FleetSummary };
}

// ---- Fleet summary ------------------------------------------------------------------
//
// The fleet overview wants a few facts from every online host — stacks and
// their state, failed units, pool health — that live behind three different
// feature namespaces. Polling those per host from the browser would be N hosts ×
// three requests every ten seconds, so the control plane collects them in one
// fan-out and answers with this compact record, briefly cached so ten open tabs
// cost one collection. Live metrics and connection state are *not* in here:
// they already stream over the events socket.
//
// Every per-subsystem field is `null` when that subsystem isn't there to ask —
// capability reported unavailable, or the host offline — and the `errors` map
// carries the reason when asking *failed*. The two are kept apart so the page
// can stay quiet about a host that simply has no ZFS, and loud about one whose
// docker daemon stopped answering.

export interface FleetStackSummary {
    project: string;
    /** Registered name when SC manages the stack, else the compose project. */
    name: string;
    status: ComposeStackRunStatus;
    running: number;
    total: number;
}

export interface FleetPoolSummary {
    name: string;
    state: ZfsHealth;
    capacityPct: number;
    /** When the last scrub finished; null when none has ever completed. */
    lastScrubAt: number | null;
    scrubInProgress: boolean;
}

export type FleetSubsystem = "docker" | "systemd" | "zfs";

export interface FleetHostSummary {
    hostId: string;
    docker: { containersRunning: number; containersTotal: number; stacks: FleetStackSummary[] } | null;
    /** Units in a failed state. */
    failedUnits: string[] | null;
    pools: FleetPoolSummary[] | null;
    /** Why a subsystem's field is null even though the host should have it. */
    errors: Partial<Record<FleetSubsystem, string>>;
}

export interface FleetSummary {
    hosts: FleetHostSummary[];
    /** When this collection ran — older than the poll interval means a cache hit. */
    capturedAt: number;
}
