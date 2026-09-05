import type { DashboardWidgetInstance, HostDashboard } from "@central/shared";
import { defineFeature } from "../../feature";
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

export const createDashboardFeature = (dashboards: DashboardStore) => defineFeature({
    id: "dashboard",
    name: "Host dashboard",
    description: "Widget arrangement for a host's overview page.",
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
    },
});


