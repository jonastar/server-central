import type { ProxyApplyResult, ProxyConfig, ProxyContainerStatus, ProxyRoute, ProxyState } from "@central/shared";
import type { Fleet } from "../../fleet";
import { deployStatusFromLog, PROXY_ADMIN_URL, PROXY_CONTAINER, PROXY_DEPLOY_LOG, PROXY_LABEL, proxyDeployCommand, renderCaddyConfig } from "./caddy";
import type { ProxyStore } from "./store";

/**
 * Drives the managed Caddy container on the configured proxy node: detached
 * bring-up/removal via the agent's exec, config pushes via the agent's
 * httpRequest to the loopback-bound admin API, and the observed container
 * state for the UI.
 */
export class ProxyManager {
    constructor(
        private readonly fleet: Fleet,
        private readonly store: ProxyStore,
    ) { }

    async state(): Promise<ProxyState> {
        const config = this.store.config;
        return {
            config,
            routes: this.store.routes,
            container: config ? await this.containerStatus(config.nodeId) : null,
            lastApply: this.store.lastApply,
        };
    }

    /** Persist the proxy config (null clears it). Deploy stays a separate,
     *  explicit step — changing the node here doesn't touch containers. */
    async setConfig(config: ProxyConfig | null): Promise<void> {
        await this.store.setConfig(config);
    }

    // Route mutations persist first, then re-push the rendered config without
    // blocking the response on it — the outcome lands in lastApply, which the
    // UI polls. A failed push never loses the saved route.

    async createRoute(route: Omit<ProxyRoute, "id">): Promise<ProxyRoute> {
        const created = await this.store.createRoute(route);
        void this.apply();
        return created;
    }

    async updateRoute(route: ProxyRoute): Promise<void> {
        await this.store.updateRoute(route);
        void this.apply();
    }

    async deleteRoute(routeId: string): Promise<void> {
        await this.store.deleteRoute(routeId);
        void this.apply();
    }

    /** Start (or replace) the proxy container. Returns once the detached
     *  pull+run chain is launched; progress shows up as container status. */
    async deploy(): Promise<void> {
        const config = this.requireConfig();
        const res = await this.fleet.get(config.nodeId).exec(proxyDeployCommand(config));
        if (res.code !== 0) {
            throw new Error((res.stdout + res.stderr).trim().split("\n")[0] || "Failed to launch the proxy deploy");
        }
    }

    /** Remove the proxy container. The named volumes (certs, autosaved config)
     *  survive, so a later deploy resumes where it left off. */
    async remove(): Promise<void> {
        const config = this.requireConfig();
        const res = await this.fleet.get(config.nodeId).exec(`docker rm -f ${PROXY_CONTAINER} 2>&1`);
        if (res.code !== 0 && !/no such container/i.test(res.stdout + res.stderr)) {
            throw new Error((res.stdout + res.stderr).trim().split("\n")[0] || "Failed to remove the proxy container");
        }
    }

    /**
     * Render the current config + enabled routes to Caddy JSON and push it to
     * the admin API. Atomic on the Caddy side: a rejected config leaves the
     * previous one serving. The outcome is persisted as lastApply either way.
     */
    async apply(): Promise<ProxyApplyResult> {
        let result: ProxyApplyResult;
        try {
            const config = this.requireConfig();
            const body = JSON.stringify(renderCaddyConfig(config, this.store.routes, (nodeId) => this.resolveNodeIp(nodeId)));
            const res = await this.fleet.get(config.nodeId).httpRequest(`${PROXY_ADMIN_URL}/load`, "POST", "application/json", body);
            if (res.status !== 200) {
                const detail = res.body.trim().split("\n")[0];
                throw new Error(`Caddy rejected the config (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
            }
            result = { ok: true, at: Date.now() };
        } catch (err) {
            result = { ok: false, error: err instanceof Error ? err.message : String(err), at: Date.now() };
        }
        await this.store.setLastApply(result);
        return result;
    }

    /** The LAN address Caddy dials for a target node: the agent-reported
     *  primary IPv4, falling back to the connection's source IP. Known-but-
     *  offline nodes still resolve, so their routes render (and fail at
     *  request time, honestly) rather than blocking every apply. */
    private resolveNodeIp(nodeId: string): string {
        const entry = this.fleet.entries().find((e) => e.id === nodeId);
        const ip = entry?.status.info?.primaryIp ?? entry?.status.remoteIp;
        if (!ip) {
            throw new Error(`No known address for route target node ${entry?.name ?? nodeId}`);
        }
        return ip;
    }

    private async containerStatus(nodeId: string): Promise<ProxyContainerStatus> {
        try {
            const agent = this.fleet.get(nodeId);
            const res = await agent.exec(`docker ps -a --filter label=${PROXY_LABEL} --format '{{json .}}' 2>&1`);
            if (res.code !== 0) {
                return { present: false, error: (res.stdout + res.stderr).trim().split("\n")[0] || "docker unavailable" };
            }
            const line = res.stdout.split("\n").map((l) => l.trim()).find(Boolean);
            if (!line) {
                // No container: the deploy is either still running or it failed
                // and left nothing behind. Its log tells them apart — see
                // deployStatusFromLog. A log older than 15 minutes is stale
                // noise about a previous deploy, so it isn't read at all.
                const log = await agent.exec(`find ${PROXY_DEPLOY_LOG} -mmin -15 2>/dev/null | grep -q . && tail -n 5 ${PROXY_DEPLOY_LOG}`);
                return deployStatusFromLog(log.stdout);
            }
            const row = JSON.parse(line) as { State?: string; Status?: string; Image?: string };
            const status: ProxyContainerStatus = { present: true, state: row.State, status: row.Status, image: row.Image };
            if (row.State && row.State !== "running") {
                // Why it isn't running lives in the container's State.Error
                // (e.g. "failed to bind host port …: address already in use").
                const inspect = await agent.exec(`docker inspect ${PROXY_CONTAINER} --format '{{.State.Error}}' 2>/dev/null`);
                const detail = inspect.code === 0 ? inspect.stdout.trim() : "";
                if (detail) {
                    status.error = detail;
                }
            }
            return status;
        } catch (err) {
            return { present: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    private requireConfig() {
        const config = this.store.config;
        if (!config) {
            throw new Error("No proxy node is configured");
        }
        return config;
    }
}
