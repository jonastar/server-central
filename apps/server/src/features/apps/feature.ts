import type { AuthContext } from "../../auth";
import { defineFeature } from "../../feature";
import type { OidcStore } from "../oidc/store";
import type { AppStore } from "./store";

// The spine of the App system (doc/idea_app_system.md): identity and declared
// role names, with sub-resources pointing at it by `appId`. It deliberately has
// no runtime — start/stop, directories and volumes arrive with Apps v1, on this
// same record.

export const createAppsFeature = (apps: AppStore, oidc: OidcStore) => defineFeature({
    id: "apps",
    name: "Apps",
    description: "The apps this installation runs, and the role names each one understands.",
    experimental: false,

    async init() {
        await apps.init();
    },
    ops: {
        async list(_data, ctx?: AuthContext) {
            return apps.list();
        },

        async create(data) {
            return apps.create(data.name, data.slug, data.roles ?? [], data.requireRole === true);
        },

        async update(data) {
            await apps.update(data.app);
        },

        async delete(data) {
            // Counted here rather than in the store: which stores reference an
            // App is composition knowledge, the same way `deleteRole` is handed
            // its holder count instead of reaching into AuthStore.
            const referencing = oidc.listClients().filter((c) => c.appId === data.appId).length;
            await apps.delete(data.appId, referencing);
        },
    },
});
