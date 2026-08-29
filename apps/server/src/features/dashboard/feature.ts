import type { DashboardWidgetInstance, HostDashboard } from "@central/shared";
import type { Feature, FeatureApiHandlers } from "../../feature";
import type { DashboardStore } from "./store";

// The per-host overview's arrangement. This feature is unusual in owning almost
// nothing: the widgets themselves are a frontend registry (apps/web/src/dashboard),
// and all the control plane keeps is the ordered list of cards someone dragged
// into place, plus each card's opaque config blob. See doc/idea_host_dashboard.md.
//
// It is a control-plane feature, not a host one: it declares no host capability
// and dispatches nothing to an agent. A layout can be read and edited for a host
// that is offline — which is the point, since a dashboard is how you'd describe
// what you expect a box to be doing.

export function createDashboardFeature(dashboards: DashboardStore): Feature<DashboardOps> {
    return {
        descriptor: {
            id: "dashboard",
            name: "Host dashboard",
            description: "Widget arrangement for a host's overview page.",
            experimental: false,
        },
        async init() {
            await dashboards.init();
        },
        apiHandlers() {
            return dashboardApiHandlers(dashboards);
        },
    };
}

export type DashboardOps = "getHostDashboard" | "setHostDashboard" | "resetHostDashboard";

export function dashboardApiHandlers(dashboards: DashboardStore): FeatureApiHandlers<DashboardOps> {
    return {
        async handleGetHostDashboard(data: { hostId: string }): Promise<HostDashboard | null> {
            return dashboards.get(data.hostId);
        },

        async handleSetHostDashboard(data: { hostId: string; widgets: DashboardWidgetInstance[] }): Promise<HostDashboard> {
            return dashboards.set(data.hostId, data.widgets);
        },

        async handleResetHostDashboard(data: { hostId: string }): Promise<void> {
            await dashboards.reset(data.hostId);
        },
    };
}
