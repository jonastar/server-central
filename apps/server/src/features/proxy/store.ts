import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProxyApplyResult, ProxyConfig, ProxyRoute } from "@central/shared";
import { CONFIG_DIR, writeFileAtomic } from "../../config";

interface ProxyPersisted {
    config: ProxyConfig | null;
    routes: ProxyRoute[];
    lastApply: ProxyApplyResult | null;
}

const EMPTY: ProxyPersisted = { config: null, routes: [], lastApply: null };

/** Hostname a route can match: dot-separated labels, no wildcards in v1. */
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

function validateRoute(route: Omit<ProxyRoute, "id">): void {
    if (!HOST_RE.test(route.host)) {
        throw new Error(`Invalid route host: ${route.host || "(empty)"}`);
    }
    if (route.pathPrefix !== undefined && !/^\/[^\s]*$/.test(route.pathPrefix)) {
        throw new Error(`Path prefix must start with "/" and contain no spaces`);
    }
    if (!route.target.nodeId) {
        throw new Error("Route target node is required");
    }
    const port = route.target.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid target port: ${port}`);
    }
}

/**
 * File-backed reverse-proxy state (`.sc-data/proxy.json`, same atomic-write
 * shape as the other stores): the proxy config, the route list, and the
 * outcome of the last config apply.
 */
export class ProxyStore {
    private state: ProxyPersisted = EMPTY;
    private readonly file: string;

    constructor(dataDir: string = CONFIG_DIR) {
        this.file = path.join(dataDir, "proxy.json");
    }

    async init(): Promise<void> {
        try {
            this.state = JSON.parse(await fs.readFile(this.file, "utf8")) as ProxyPersisted;
        } catch {
            this.state = EMPTY;
        }
    }

    get config(): ProxyConfig | null {
        return this.state.config;
    }

    get routes(): ProxyRoute[] {
        return this.state.routes;
    }

    get lastApply(): ProxyApplyResult | null {
        return this.state.lastApply;
    }

    async setConfig(config: ProxyConfig | null): Promise<void> {
        if (config) {
            if (!config.nodeId) {
                throw new Error("A proxy node is required");
            }
            for (const port of [config.httpPort, config.httpsPort]) {
                if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
                    throw new Error(`Invalid proxy port: ${port}`);
                }
            }
            if (config.httpPort !== undefined && config.httpPort === config.httpsPort) {
                throw new Error("HTTP and HTTPS ports must differ");
            }
        }
        this.state.config = config;
        await this.persist();
    }

    async createRoute(route: Omit<ProxyRoute, "id">): Promise<ProxyRoute> {
        validateRoute(route);
        const created: ProxyRoute = { ...route, id: randomUUID() };
        this.state.routes.push(created);
        await this.persist();
        return created;
    }

    async updateRoute(route: ProxyRoute): Promise<void> {
        const idx = this.state.routes.findIndex((r) => r.id === route.id);
        if (idx === -1) {
            throw new Error("Unknown route");
        }
        validateRoute(route);
        this.state.routes[idx] = route;
        await this.persist();
    }

    async deleteRoute(routeId: string): Promise<void> {
        const idx = this.state.routes.findIndex((r) => r.id === routeId);
        if (idx === -1) {
            throw new Error("Unknown route");
        }
        this.state.routes.splice(idx, 1);
        await this.persist();
    }

    async setLastApply(result: ProxyApplyResult): Promise<void> {
        this.state.lastApply = result;
        await this.persist();
    }

    private async persist(): Promise<void> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await writeFileAtomic(this.file, JSON.stringify(this.state, null, 2));
    }
}
