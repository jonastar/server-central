// ---- Reverse proxy ---------------------------------------------------------------
//
// SC-managed Caddy on one designated node, HTTP(S) only. Routes store intent
// (node + published host port), never a resolved IP — the control plane renders
// them to Caddy JSON (resolving each node's LAN IP at render time) and pushes
// the config through the node's agent to Caddy's loopback-bound admin API.
// Design: doc/idea_reverse_proxy.md.

export interface ProxyConfig {
    /** Node the Caddy container runs on. */
    nodeId: string;
    /** ACME registration email, used when certMode is "auto". */
    acmeEmail?: string;
    /** "auto" = Caddy automatic HTTPS (public hostnames, ACME); "internal" =
     *  Caddy's local CA for LAN-only hostnames. */
    certMode: "auto" | "internal";
    /** Host ports the container's 80/443 publish on; defaults 80/443. For
     *  nodes where those are taken (e.g. the platform's own web UI). ACME
     *  HTTP-01 and Caddy's HTTP→HTTPS redirects still assume the *public*
     *  side reaches 80/443, so non-standard ports lean on router mappings. */
    httpPort?: number;
    httpsPort?: number;
}

export interface ProxyRouteTarget {
    nodeId: string;
    /** Published host port on that node. */
    port: number;
    /** Scheme Caddy dials the upstream with. */
    scheme: "http" | "https";
    /** Skip upstream TLS verification, for apps self-serving HTTPS with a
     *  self-signed cert. Only meaningful when scheme is "https". */
    insecureSkipVerify?: boolean;
}

export interface ProxyRoute {
    id: string;
    /** Hostname the route matches, e.g. "jellyfin.example.com". */
    host: string;
    /** Optional path prefix the route matches, e.g. "/api". */
    pathPrefix?: string;
    target: ProxyRouteTarget;
    /** Disabled routes are kept but not rendered into the proxy config. */
    enabled: boolean;
}

/** Outcome of the last attempt to render + push config to the proxy. */
export interface ProxyApplyResult {
    ok: boolean;
    error?: string;
    at: number;
}

/** The proxy container as observed on the designated node right now. */
export interface ProxyContainerStatus {
    present: boolean;
    /** Container state (running | exited | …) when present. */
    state?: string;
    /** Human status, e.g. "Up 3 days", when present. */
    status?: string;
    /** Image the container was created from, when present. */
    image?: string;
    /** Why the container couldn't be inspected (node offline, docker missing). */
    error?: string;
    /** The detached deploy chain is still running (pulling, or replacing the old
     *  container) and hasn't produced a container yet — pending, not broken. */
    deploying?: boolean;
}

export interface ProxyState {
    config: ProxyConfig | null;
    routes: ProxyRoute[];
    /** Null until a proxy node is configured. */
    container: ProxyContainerStatus | null;
    lastApply: ProxyApplyResult | null;
}


/**
 * Owner-only. Route mutations re-apply the rendered config immediately; the
 * result lands in `ProxyState.lastApply`.
 */
export interface ProxyOperations {
    getState: { data: void; response: ProxyState };
    /** Persist the proxy config (null clears it). Doesn't deploy by itself. */
    setConfig: { data: { config: ProxyConfig | null }; response: void };
    // Start (or repair) the Caddy container on the configured node. The image
    // pull + run happens detached on the host — poll getProxyState for progress.
    deploy: { data: void; response: void };
    /** Remove the proxy container (named volumes with certs/config survive). */
    remove: { data: void; response: void };
    createRoute: { data: { route: Omit<ProxyRoute, "id"> }; response: ProxyRoute };
    updateRoute: { data: { route: ProxyRoute }; response: void };
    deleteRoute: { data: { routeId: string }; response: void };
    /** Re-render + push the config on demand (retry after a failed apply). */
    applyConfig: { data: void; response: ProxyApplyResult };
}
