import type { ProxyApplyResult, ProxyConfig, ProxyRoute, ProxyState } from "@central/shared";
import { requireOwner, type AuthContext } from "../../auth";
import type { Feature, FeatureApiHandlers } from "../../feature";
import type { ProxyManager } from "./manager";
import type { ProxyStore } from "./store";

// SC-managed Caddy on one designated node. See doc/idea_reverse_proxy.md and the
// ProxyManager for the deploy/apply mechanics. Owner-only throughout: a route
// change re-points public traffic.

export function createProxyFeature(proxy: ProxyManager, store: ProxyStore): Feature<ProxyOps> {
    return {
        descriptor: {
            id: "proxy",
            name: "Reverse proxy",
            description: "SC-managed Caddy reverse proxy and its routes. See doc/idea_reverse_proxy.md.",
            experimental: false,
            dependsOn: ["docker"],
        },
        async init() {
            await store.init();
        },
        apiHandlers() {
            return proxyApiHandlers(proxy);
        },
    };
}

export type ProxyOps = "getProxyState" | "setProxyConfig" | "deployProxy" | "removeProxy"
    | "createProxyRoute" | "updateProxyRoute" | "deleteProxyRoute" | "applyProxyConfig";

export function proxyApiHandlers(proxy: ProxyManager): FeatureApiHandlers<ProxyOps> {
    return {
        async handleGetProxyState(_data: void, ctx?: AuthContext): Promise<ProxyState> {
            requireOwner(ctx);
            return proxy.state();
        },

        async handleSetProxyConfig(data: { config: ProxyConfig | null }, ctx?: AuthContext): Promise<void> {
            requireOwner(ctx);
            await proxy.setConfig(data.config);
        },

        async handleDeployProxy(_data: void, ctx?: AuthContext): Promise<void> {
            requireOwner(ctx);
            await proxy.deploy();
        },

        async handleRemoveProxy(_data: void, ctx?: AuthContext): Promise<void> {
            requireOwner(ctx);
            await proxy.remove();
        },

        async handleCreateProxyRoute(data: { route: Omit<ProxyRoute, "id"> }, ctx?: AuthContext): Promise<ProxyRoute> {
            requireOwner(ctx);
            return proxy.createRoute(data.route);
        },

        async handleUpdateProxyRoute(data: { route: ProxyRoute }, ctx?: AuthContext): Promise<void> {
            requireOwner(ctx);
            await proxy.updateRoute(data.route);
        },

        async handleDeleteProxyRoute(data: { routeId: string }, ctx?: AuthContext): Promise<void> {
            requireOwner(ctx);
            await proxy.deleteRoute(data.routeId);
        },

        async handleApplyProxyConfig(_data: void, ctx?: AuthContext): Promise<ProxyApplyResult> {
            requireOwner(ctx);
            return proxy.apply();
        },
    };
}
