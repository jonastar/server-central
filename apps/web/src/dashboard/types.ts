import type { ComponentType } from "react";
import type { HostCapability, ServerEntry, WidgetSpan } from "@central/shared";

/**
 * The widget contract.
 *
 * This registry is frontend-native and only its *ids* cross the wire — the
 * control plane stores an arrangement of `{ widget, span, config }` and knows
 * nothing about what any of them mean. See doc/idea_host_dashboard.md §1 for
 * why a server-emitted widget description was rejected: it would mean inventing
 * a rendering DSL that has to grow a case for every visual a feature ever wants,
 * each of which is already a React component on this side.
 */

export interface WidgetProps<TConfig = WidgetConfig> {
    serverId: string;
    entry: ServerEntry;
    /** This card's settings, already merged over `defaultConfig`. */
    config: TConfig;
}

export interface WidgetConfigProps<TConfig = WidgetConfig> {
    serverId: string;
    entry: ServerEntry;
    config: TConfig;
    onChange(next: TConfig): void;
}

export type WidgetConfig = Record<string, unknown>;

export interface DashboardWidget<TConfig extends WidgetConfig = WidgetConfig> {
    /** Stable id, stored in saved layouts — never renamed. Conventionally
     *  `<featureId>.<thing>`, though only uniqueness is enforced. */
    id: string;
    /** The server `FeatureDescriptor.id` this widget belongs to. Groups the
     *  palette, and is the honest answer to "who put this here". */
    featureId: string;
    title: string;
    description: string;
    /** Hidden on hosts whose agent positively reported this missing — the same
     *  gate `SERVER_TABS` applies to whole tabs. Unknown (older agent, never
     *  probed) still shows, deliberately: same call as App.tsx's. */
    requires?: HostCapability;
    defaultSpan: WidgetSpan;
    /** Narrowest span that still renders sensibly; the span control won't go
     *  below it. */
    minSpan?: WidgetSpan;
    /** Sort key in the default layout a never-customized host gets. Absent
     *  means the widget exists only in the "Add widget" palette. */
    inDefaultLayout?: number;
    component: ComponentType<WidgetProps<TConfig>>;
    /**
     * Editor for this widget's config, rendered in the card's settings modal.
     *
     * A component rather than a field schema because the interesting configs
     * are host-dependent — "which stack" has to offer *this host's* stacks —
     * and a static descriptor can't express that without growing an
     * options-fetching protocol of its own.
     */
    configForm?: ComponentType<WidgetConfigProps<TConfig>>;
    defaultConfig?: TConfig;
    /** Subtitle distinguishing two cards of the same widget ("jellyfin"). */
    label?(config: TConfig): string | null;
}

/**
 * A widget with any config type.
 *
 * Same role as `AnyFeature` on the server: every concrete widget is assignable
 * to it, so one array can hold the lot, while `defineWidget` keeps each
 * declaration's own config type checked at the point it's written.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDashboardWidget = DashboardWidget<any>;

/** Declare a widget with its config type checked against its component and
 *  form, then erase it for the registry. */
export function defineWidget<TConfig extends WidgetConfig>(widget: DashboardWidget<TConfig>): AnyDashboardWidget {
    return widget;
}
