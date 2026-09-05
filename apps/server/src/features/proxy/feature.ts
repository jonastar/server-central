import type { ProxyApplyResult, ProxyConfig, ProxyRoute, ProxyState } from "@central/shared";
import type { AuthContext } from "../../auth";
import { defineFeature } from "../../feature";
import type { ProxyManager } from "./manager";
import type { ProxyStore } from "./store";

// SC-managed Caddy on one designated node. See doc/idea_reverse_proxy.md and the
// ProxyManager for the deploy/apply mechanics. Owner-only throughout: a route
// change re-points public traffic.

export const createProxyFeature = (proxy: ProxyManager, store: ProxyStore) => defineFeature({
    id: "proxy",
    name: "Reverse proxy",
    description: "SC-managed Caddy reverse proxy and its routes. See doc/idea_reverse_proxy.md.",
    experimental: false,
    dependsOn: ["docker"],
    
    async init() {
        await store.init();
            },
    ops: {
        async getState(_data, ctx?: AuthContext) {
            return proxy.state();
        },

        async setConfig(data, ctx?: AuthContext) {
            await proxy.setConfig(data.config);
        },

        async deploy(_data, ctx?: AuthContext) {
            await proxy.deploy();
        },

        async remove(_data, ctx?: AuthContext) {
            await proxy.remove();
        },

        async createRoute(data, ctx?: AuthContext) {
            return proxy.createRoute(data.route);
        },

        async updateRoute(data, ctx?: AuthContext) {
            await proxy.updateRoute(data.route);
        },

        async deleteRoute(data, ctx?: AuthContext) {
            await proxy.deleteRoute(data.routeId);
        },

        async applyConfig(_data, ctx?: AuthContext) {
            return proxy.apply();
        },
    },
});


