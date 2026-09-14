import type { DashboardWidgetInstance, HostDashboard } from "@central/shared";
import { defineFeature } from "../../feature";
import type { DashboardStore } from "./store";
import type { FleetSummaryCollector } from "./fleet-summary";

// The per-host overview's arrangement. This feature is unusual in owning almost
// nothing: the widgets themselves are a frontend registry (apps/web/src/dashboard),
// and all the control plane keeps is the ordered list of cards someone dragged
// into place, plus each card's opaque config blob. See doc/idea_host_dashboard.md.
//
// It is a control-plane feature, not a host one: it declares no host capability
// and dispatches nothing to an agent for layouts. A layout can be read and
// edited for a host that is offline — which is the point, since a dashboard is
// how you'd describe what you expect a box to be doing.
//
// `fleetSummary` is the one op that does reach hosts — the fleet overview's
// stacks/failed-units/pools digest, collected in one fan-out rather than by the
// browser polling three namespaces per host. See fleet-summary.ts.

export const createDashboardFeature = (dashboards: DashboardStore, fleetSummary: FleetSummaryCollector) => defineFeature({
    id: "dashboard",
    name: "Dashboards",
    description: "Widget arrangement for a host's overview page, and the fleet overview's summary.",
    experimental: false,
    
    async init() {
        await dashboards.init();
            },
    ops: {
        async get(data) {
            return dashboards.get(data.hostId);
        },

        async set(data) {
            return dashboards.set(data.hostId, data.widgets);
        },

        async reset(data) {
            await dashboards.reset(data.hostId);
        },

        async fleetSummary() {
            return fleetSummary.get();
        },
    },
});


