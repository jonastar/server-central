import type { ProxyConfig, ProxyRoute } from "@central/shared";

/** Pinned to the minor so a redeploy picks up patch releases only. */
export const PROXY_IMAGE = "caddy:2.10";
export const PROXY_CONTAINER = "sc-proxy";
export const PROXY_LABEL = "sc.proxy";
/** Caddy's admin API, published loopback-only on the proxy node's host. */
export const PROXY_ADMIN_URL = "http://127.0.0.1:2019";
/** Where the detached bring-up chain logs on the proxy node. */
export const PROXY_DEPLOY_LOG = "/tmp/sc-proxy-deploy.log";

/**
 * The full Caddy JSON config for the current route set, pushed atomically to
 * the admin API's /load. Routes store intent (node + port); `resolveNodeIp`
 * turns a node id into the LAN address Caddy dials — same-node and cross-node
 * targets resolve identically in v1 (published host ports, see the design doc).
 *
 * The admin listener must be re-declared here: a loaded config replaces the
 * CADDY_ADMIN default wholesale, and losing it would lock us out of /load.
 */
export function renderCaddyConfig(
    config: ProxyConfig,
    routes: ProxyRoute[],
    resolveNodeIp: (nodeId: string) => string,
): object {
    const enabled = routes.filter((r) => r.enabled);
    // Order determines match priority: within a host, longer (more specific)
    // path prefixes first, prefix-less catch-alls last.
    const ordered = [...enabled].sort((a, b) =>
        a.host !== b.host
            ? a.host.localeCompare(b.host)
            : (b.pathPrefix?.length ?? -1) - (a.pathPrefix?.length ?? -1),
    );

    const caddyRoutes = ordered.map((r) => {
        const upstreamTls = r.target.scheme === "https"
            ? { tls: r.target.insecureSkipVerify ? { insecure_skip_verify: true } : {} }
            : null;
        return {
            match: [{
                host: [r.host],
                ...(r.pathPrefix ? { path: [`${r.pathPrefix.replace(/\/$/, "")}/*`, r.pathPrefix] } : {}),
            }],
            handle: [{
                handler: "reverse_proxy",
                upstreams: [{ dial: `${resolveNodeIp(r.target.nodeId)}:${r.target.port}` }],
                ...(upstreamTls ? { transport: { protocol: "http", ...upstreamTls } } : {}),
            }],
            terminal: true,
        };
    });

    // certMode "internal" signs everything with Caddy's local CA (LAN-only
    // hostnames ACME can't see); "auto" is Caddy's automatic HTTPS, with the
    // ACME account email attached when configured.
    const tlsPolicy = config.certMode === "internal"
        ? { issuers: [{ module: "internal" }] }
        : config.acmeEmail
            ? { issuers: [{ module: "acme", email: config.acmeEmail }] }
            : null;

    return {
        admin: { listen: "0.0.0.0:2019" },
        apps: {
            http: {
                servers: {
                    // One :443 server; automatic HTTPS adds the :80 redirects.
                    sc: { listen: [":443"], routes: caddyRoutes },
                },
            },
            ...(tlsPolicy ? { tls: { automation: { policies: [tlsPolicy] } } } : {}),
        },
    };
}

/**
 * The detached bring-up command for the proxy container. The image pull can
 * exceed the agent's 30s exec timeout, so the whole chain runs under nohup in
 * the background and the caller polls container status instead of waiting.
 * Host ports come from validated config ints; everything else is a constant —
 * nothing user-controlled is interpolated.
 */
export function proxyDeployCommand(config: ProxyConfig): string {
    const run = [
        "docker run -d",
        `--name ${PROXY_CONTAINER}`,
        `--label ${PROXY_LABEL}=1`,
        "--restart unless-stopped",
        // Container-internal ports stay 80/443 (what Caddy binds and what ACME
        // expects); only the host side moves when 80/443 are taken on the node.
        `-p ${config.httpPort ?? 80}:80 -p ${config.httpsPort ?? 443}:443`,
        // Admin API: reachable from the host (for the agent), never from the LAN.
        "-p 127.0.0.1:2019:2019",
        "-e CADDY_ADMIN=0.0.0.0:2019",
        // Named volumes: certs (/data) and the autosaved config (/config)
        // survive container replacement.
        "-v sc-proxy-data:/data -v sc-proxy-config:/config",
        PROXY_IMAGE,
        // --resume reloads the last admin-API-applied config on restart, so the
        // proxy stays configured while the control plane is down.
        "caddy run --resume",
    ].join(" ");
    // Sequential, not &&-chained: a failed pull (host offline) still runs from
    // a locally cached image; a truly absent image fails at `docker run`, and
    // either way the outcome is visible via container status + the log file.
    const chain = `docker pull ${PROXY_IMAGE}; docker rm -f ${PROXY_CONTAINER}; ${run}`;
    return `nohup sh -c '${chain}' >${PROXY_DEPLOY_LOG} 2>&1 &`;
}
