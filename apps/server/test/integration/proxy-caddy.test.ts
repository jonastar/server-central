import { expect, test } from "bun:test";
import type { ProxyConfig, ProxyRoute } from "@central/shared";
import { PROXY_NETWORK } from "@central/shared";
import { deployStatusFromLog, PROXY_DEPLOY_DONE, proxyDeployScript, renderCaddyConfig } from "../../src/features/proxy/caddy";

// The renderer is the contract between SC's route model and Caddy: what it
// emits is exactly what gets POSTed to /load. These pin the parts that would
// fail silently at runtime — the admin listener (losing it locks SC out of
// /load), match ordering, and the upstream-TLS transport shapes.

const config: ProxyConfig = { nodeId: "node-a", certMode: "auto" };

const ips: Record<string, string> = { "node-a": "10.0.0.5", "node-b": "10.0.0.6" };
const resolve = (nodeId: string) => {
    const ip = ips[nodeId];
    if (!ip) {
        throw new Error(`unknown node ${nodeId}`);
    }
    return ip;
};

function route(over: Partial<ProxyRoute> & { host: string }): ProxyRoute {
    return {
        id: crypto.randomUUID(),
        enabled: true,
        target: { kind: "hostPort", nodeId: "node-b", port: 8096, scheme: "http" },
        ...over,
    };
}

type Rendered = {
    admin: { listen: string };
    apps: {
        http: { servers: { sc: { listen: string[]; routes: Array<{ match: Array<{ host: string[]; path?: string[] }>; handle: Array<Record<string, unknown>>; terminal: boolean }> } } };
        tls?: { automation: { policies: Array<{ issuers: Array<Record<string, unknown>> }> } };
    };
};

test("renders the admin listener, host-matched routes, and LAN-IP upstreams", () => {
    const out = renderCaddyConfig(config, [route({ host: "jellyfin.example.com" })], resolve) as Rendered;

    // Without re-declaring admin, a loaded config reverts it to localhost
    // inside the container and SC can never push config again.
    expect(out.admin.listen).toBe("0.0.0.0:2019");

    const server = out.apps.http.servers.sc;
    expect(server.listen).toEqual([":443"]);
    expect(server.routes).toHaveLength(1);
    expect(server.routes[0].match[0].host).toEqual(["jellyfin.example.com"]);
    expect(server.routes[0].handle[0]).toEqual({
        handler: "reverse_proxy",
        upstreams: [{ dial: "10.0.0.6:8096" }],
    });
    // No email, certMode auto: leave Caddy's TLS defaults alone.
    expect(out.apps.tls).toBeUndefined();
});

test("disabled routes are not rendered", () => {
    const out = renderCaddyConfig(config, [route({ host: "a.example.com", enabled: false })], resolve) as Rendered;
    expect(out.apps.http.servers.sc.routes).toHaveLength(0);
});

test("within a host, longer path prefixes match before the catch-all", () => {
    const out = renderCaddyConfig(config, [
        route({ host: "app.example.com" }),
        route({ host: "app.example.com", pathPrefix: "/api/v2" }),
        route({ host: "app.example.com", pathPrefix: "/api" }),
    ], resolve) as Rendered;

    const paths = out.apps.http.servers.sc.routes.map((r) => r.match[0].path?.[1] ?? "(none)");
    expect(paths).toEqual(["/api/v2", "/api", "(none)"]);
    // Prefix matches both the bare path and everything under it.
    expect(out.apps.http.servers.sc.routes[0].match[0].path).toEqual(["/api/v2/*", "/api/v2"]);
});

test("https upstreams get a TLS transport; insecureSkipVerify only when asked", () => {
    const out = renderCaddyConfig(config, [
        route({ host: "a.example.com", target: { kind: "hostPort", nodeId: "node-b", port: 8443, scheme: "https" } }),
        route({ host: "b.example.com", target: { kind: "hostPort", nodeId: "node-b", port: 9443, scheme: "https", insecureSkipVerify: true } }),
    ], resolve) as Rendered;

    const [verified, skipped] = out.apps.http.servers.sc.routes.map((r) => r.handle[0]);
    expect(verified.transport).toEqual({ protocol: "http", tls: {} });
    expect(skipped.transport).toEqual({ protocol: "http", tls: { insecure_skip_verify: true } });
});

test("cert modes: internal CA policy, or ACME with the configured email", () => {
    const internal = renderCaddyConfig({ nodeId: "node-a", certMode: "internal" }, [], resolve) as Rendered;
    expect(internal.apps.tls?.automation.policies).toEqual([{ issuers: [{ module: "internal" }] }]);

    const acme = renderCaddyConfig({ nodeId: "node-a", certMode: "auto", acmeEmail: "ops@example.com" }, [], resolve) as Rendered;
    expect(acme.apps.tls?.automation.policies).toEqual([{ issuers: [{ module: "acme", email: "ops@example.com" }] }]);
});

test("deploy command publishes on 80/443 by default, or the configured host ports", () => {
    expect(proxyDeployScript(config)).toContain("-p 80:80 -p 443:443");
    // Container-internal side stays 80/443 — only the host side moves.
    expect(proxyDeployScript({ ...config, httpPort: 8080, httpsPort: 8443 })).toContain("-p 8080:80 -p 8443:443");
});

test("resolving an unknown target node fails the render (not a silent bad dial)", () => {
    expect(() => renderCaddyConfig(config, [route({ host: "a.example.com", target: { kind: "hostPort", nodeId: "ghost", port: 80, scheme: "http" } })], resolve)).toThrow("unknown node");
});

// Container targets: a service on the proxy's docker network, dialed by its
// alias. No host port, no IP — nothing for the resolver to do — and only on
// the proxy node until the cross-node tunnel exists.

test("same-node container targets dial the network alias, not an IP", () => {
    const out = renderCaddyConfig(config, [
        route({ host: "jf.example.com", target: { kind: "container", nodeId: "node-a", stackId: "s1", service: "jellyfin", alias: "media-jellyfin", port: 8096, scheme: "http" } }),
    ], () => { throw new Error("resolver must not be consulted for container targets"); }) as Rendered;
    expect(out.apps.http.servers.sc.routes[0].handle[0]).toEqual({
        handler: "reverse_proxy",
        upstreams: [{ dial: "media-jellyfin:8096" }],
    });
});

test("a container target on another node fails the render until the tunnel exists", () => {
    const remote = route({ host: "jf.example.com", target: { kind: "container", nodeId: "node-b", stackId: "s1", service: "jellyfin", alias: "media-jellyfin", port: 8096, scheme: "http" } });
    expect(() => renderCaddyConfig(config, [remote], resolve)).toThrow(/another node/);
});

test("deploy joins the proxy network, creating it once and never recreating it", () => {
    const cmd = proxyDeployScript(config);
    expect(cmd).toContain(`--network ${PROXY_NETWORK}`);
    expect(cmd).toContain(`docker network inspect ${PROXY_NETWORK} >/dev/null 2>&1 || docker network create ${PROXY_NETWORK}`);
    // Stacks reference the network as external, so it must exist before the
    // container joins it and must not be torn down with the old container.
    expect(cmd.indexOf("docker network create")).toBeLessThan(cmd.indexOf("docker rm -f"));
    expect(cmd).not.toContain("network rm");
});

// A detached deploy leaves no container behind while it pulls, which used to
// read exactly like a failed one: the pull's own output came back as the
// container's `error`, so every deploy flashed red until the image landed.

test("the deploy chain announces itself and marks its own end", () => {
    const cmd = proxyDeployScript(config);
    expect(cmd.indexOf("echo \"deploying")).toBeLessThan(cmd.indexOf("docker pull"));
    expect(cmd).toContain(`echo "${PROXY_DEPLOY_DONE} rc=$?"`);
    // The backgrounding and the redirect belong to the agent's `detach` now, not
    // to a `nohup … >log &` wrapper the control plane pastes around the chain.
    expect(cmd).not.toContain("nohup");
    expect(cmd).not.toContain(">/tmp/");
});

test("a log with no end marker is a deploy in progress, not a failure", () => {
    const status = deployStatusFromLog("deploying caddy:2.10\n2.10: Pulling from library/caddy\n");
    expect(status).toEqual({ present: false, deploying: true });
});

test("a finished chain that left no container is the failure, and says why", () => {
    const status = deployStatusFromLog(`deploying caddy:2.10\ndocker: address already in use\n${PROXY_DEPLOY_DONE} rc=125`);
    expect(status.deploying).toBeUndefined();
    expect(status.error).toBe("Last deploy: deploying caddy:2.10 — docker: address already in use");
});

test("no recent log at all is simply not deployed", () => {
    expect(deployStatusFromLog("")).toEqual({ present: false });
});
