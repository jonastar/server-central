import type { DashboardWidgetInstance, ServerEntry } from "@central/shared";
import { hostCapabilityUnavailable } from "../utils";
import type { AnyDashboardWidget } from "./types";
import { systemWidgets } from "./widgets/system";
import { dockerWidgets } from "./widgets/docker";
import { systemdWidgets } from "./widgets/systemd";

/**
 * Every dashboard widget, composed from per-feature arrays.
 *
 * Same shape as `composeApiHandlers` on the server (doc/idea_feature_convention.md
 * §3): each feature owns its slice, this file is a dumb concatenation, and a
 * duplicate id throws at module load rather than silently shadowing. A feature
 * adds a card by exporting an array and adding one line here — the overview page
 * itself is never touched.
 */
function composeWidgets(...slices: AnyDashboardWidget[][]): AnyDashboardWidget[] {
    const all: AnyDashboardWidget[] = [];
    const seen = new Set<string>();
    for (const slice of slices) {
        for (const widget of slice) {
            if (seen.has(widget.id)) {
                throw new Error(`Two dashboard widgets claim the id "${widget.id}"`);
            }
            seen.add(widget.id);
            all.push(widget);
        }
    }
    return all;
}

export const WIDGETS = composeWidgets(systemWidgets, dockerWidgets, systemdWidgets);

const BY_ID = new Map(WIDGETS.map((w) => [w.id, w]));

/** `undefined` for a widget id this build doesn't know — a layout saved by a
 *  newer release, viewed after a downgrade. The card renders as a placeholder
 *  rather than disappearing, so the arrangement survives the round trip. */
export function findWidget(id: string): AnyDashboardWidget | undefined {
    return BY_ID.get(id);
}

/**
 * Whether a widget is usable on a host.
 *
 * Only a capability the agent *positively reported missing* hides a widget;
 * unknown (an older agent, or one that never probed) still shows it. Same call
 * App.tsx makes for whole tabs — an un-probed host shouldn't lose its dashboard.
 */
export function widgetAvailable(widget: AnyDashboardWidget, entry: ServerEntry): boolean {
    return !hostCapabilityUnavailable(entry.status, widget.requires);
}

let instanceCounter = 0;

/** Layout-local instance id. Uniqueness within one dashboard is all that's
 *  required (the store enforces it), so this needn't be a UUID. */
export function newInstanceId(widgetId: string): string {
    instanceCounter += 1;
    return `${widgetId}-${Date.now().toString(36)}-${instanceCounter}`;
}

export function instanceFor(widget: AnyDashboardWidget): DashboardWidgetInstance {
    return {
        id: newInstanceId(widget.id),
        widget: widget.id,
        span: widget.defaultSpan,
        ...(widget.defaultConfig ? { config: { ...widget.defaultConfig } } : {}),
    };
}

/**
 * The layout a host that nobody has arranged gets: every widget declaring a
 * `inDefaultLayout` order, filtered to what this host can actually do.
 *
 * Computed rather than stored, which is what lets a widget added in a later
 * release appear on every uncustomized host with no migration — and is exactly
 * why `getHostDashboard` answers `null` instead of seeding a row. See
 * doc/idea_host_dashboard.md §3, including what this costs on a host someone
 * *has* customized.
 */
export function defaultLayout(entry: ServerEntry): DashboardWidgetInstance[] {
    return WIDGETS
        .filter((w) => w.inDefaultLayout !== undefined && widgetAvailable(w, entry))
        .sort((a, b) => a.inDefaultLayout! - b.inDefaultLayout!)
        .map(instanceFor);
}
