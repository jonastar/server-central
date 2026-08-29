# Reverse Proxy (v1)

Status: v1 implemented 2026-07-13 (`apps/server/src/features/proxy/`, `httpRequest` in the
node protocol, `ProxyView` in the web app). This doc remains the design record;
the deferral ladder below is still future work. Sibling of
[idea_stack_registry.md](idea_stack_registry.md) — shares its streaming-exec concern.

## Concept and naming

Server Central deploys and manages a reverse proxy for HTTP(S) traffic into apps.
We call it **reverse proxy** (not "ingress" — that's k8s vocabulary with imported
expectations) and the user-facing objects are **routes**. The route model is the
abstraction; there is deliberately **no pluggable-backend layer** — routes are
engine-neutral, one renderer targets one engine, and swapping engines later only
means swapping the renderer.

Scope is HTTP(S) only, permanently. L4/game-server traffic is manually routed
(router port-forward + published compose ports); at most SC will later *track*
those ports on an App record (informational), never proxy them.

## Engine: Caddy

Chosen over Traefik. Traefik's docker-label auto-discovery is redundant — SC is
already the control plane that knows every container on every host, so both
engines reduce to "receive rendered config"; Caddy is the better render target
(atomic config load, no static/dynamic config split, automatic HTTPS by default,
`forward_auth` one-liner for the future auth story, applied config persists
locally so the proxy survives restarts while SC is down). Traefik's one edge —
built-in DNS-01 providers — is matched later by pulling a Caddy image variant
with the DNS plugin when a DNS provider is configured (not in v1).

## v1 scope

One designated proxy node. Host-port upstreams **uniformly**: every route
targets `<node LAN IP>:<published host port>`, even when the app sits on the
proxy's own node. One resolution rule, no docker-network special case yet.

Explicitly deferred (all layer onto the same route model without changing it):

1. **`sc-proxy` shared docker network** — same-node routes reach containers by
   name with zero published ports (bypass-proof by construction). Standard
   external-network pattern (`docker network create sc-proxy`, app stacks opt in).
2. **DOCKER-USER firewall restriction** — for auth-gated cross-node routes,
   agent-managed iptables rules allow the published port only from the proxy
   node's IP (match original dst port via `-m conntrack --ctorigdstport` since
   packets are DNAT'd before that chain). Stops honest bypass, not ARP spoofing —
   surface as "restricted, not airtight".
3. **WireGuard overlay between nodes** — no longer the endgame; it moved
   *ahead* of item 2 and of any userspace tunneling. Design and the reasoning for
   the reorder: [idea_node_overlay.md](idea_node_overlay.md). Short version —
   everything cheaper than an overlay needs an upstream abstraction that the
   overlay makes unnecessary: routes target overlay addresses, `resolveNodeIp`
   returns one, and `renderCaddyConfig` doesn't change at all. SC brokers keys and
   IPs over the agent channel (STUN work is the first building block), data flows
   directly node-to-node, ports publish bound to the wg interface IP only.
   Cross-node becomes as tight as same-node, plus stable IPs across sites.
   Still decided against tunneling app traffic through SC itself: that makes SC a
   data-plane component (SC restart = live traffic drops, streaming throughput
   through the control-plane process, A→C→B path inefficiency). That is now a
   last-resort fallback for the hosts WireGuard can't reach, never the default.
4. **`forward_auth` role gating** on routes (depends on the Role-set redesign,
   see next.md).
5. DNS-01 / wildcard certs, multiple proxy nodes, per-route headers/limits.

## Data model

```ts
/** Global proxy config — one per installation in v1. */
interface ProxyConfig {
    /** Node the Caddy container runs on. */
    nodeId: string;
    /** ACME registration email (Let's Encrypt). */
    acmeEmail?: string;
    /** "auto" = Caddy automatic HTTPS (public hostnames, HTTP-01/TLS-ALPN);
     *  "internal" = Caddy's local CA for LAN-only hostnames. */
    certMode: "auto" | "internal";
}

interface ProxyRoute {
    id: string;
    /** e.g. "jellyfin.example.com" */
    host: string;
    pathPrefix?: string;
    target: {
        nodeId: string;
        /** Published host port on that node. */
        port: number;
        scheme: "http" | "https";
        /** For apps that self-serve HTTPS with self-signed certs. */
        insecureSkipVerify?: boolean;
    };
    enabled: boolean;
}
```

Persisted alongside existing server state (same store as users/apps/agents).
Routes store *intent* (`node + port`), never a resolved IP — the renderer
resolves the node's LAN IP at render time from agent state (`remoteIp` in
`network.ts` / agent connection). Multi-homed nodes may need an optional
per-node address override; punt until it bites.

## Deployment

A single SC-managed container, no compose stack — SC recognizes it by label
across restarts and feeds it configuration through Caddy's admin API:

```
docker run -d --name sc-proxy \
  --label sc.proxy=1 \
  --restart unless-stopped \
  -p <httpPort>:80 -p <httpsPort>:443 \
  -p 127.0.0.1:2019:2019 \
  -e CADDY_ADMIN=0.0.0.0:2019 \
  -v sc-proxy-data:/data -v sc-proxy-config:/config \
  caddy:<pinned> caddy run --resume
```

Key choices:

- Host ports default to 80/443 but are configurable (`ProxyConfig.httpPort`/
  `httpsPort`) for nodes where those are taken (e.g. TrueNAS's own web UI).
  The container-internal side stays 80/443 — Caddy's binding and ACME's
  expectation — so ACME HTTP-01 and HTTP→HTTPS redirects require the *public*
  80/443 to be router-forwarded to the configured host ports.

- `caddy run --resume` — configs pushed via the admin API autosave to
  `/config/caddy/autosave.json` (named volume), and `--resume` reloads the last
  applied config on container restart. The proxy stays correctly configured
  while SC is down; no config file on the host at all.
- `CADDY_ADMIN=0.0.0.0:2019` + publish **loopback-only** — default admin binds
  localhost *inside* the container (unreachable via port mapping); this makes
  it reachable from the host but never from the LAN.
- Named volumes for `/data` (certs) + `/config` — replacing the container
  (image upgrade) is safe.

Reconcile: find container by `sc.proxy` label; recreate if missing; replace if
the image pin changed. **Known constraint:** agent `exec` has a 30s timeout
(`REQUEST_TIMEOUT_MS`, host-agent.ts) and the initial image pull can exceed it —
run `docker pull` detached (`nohup ... > log`) and poll before `docker run`;
replace with streaming exec / the task system when that lands (see
idea_stack_registry.md §4).

## Config flow (reconcile)

1. Render Caddy **JSON config** from `ProxyConfig` + enabled routes.
2. Push via a new **`httpRequest` node-protocol message**: the agent performs a
   local `fetch()` (`POST http://127.0.0.1:2019/load`, JSON body) and returns
   status + body. No curl on the host, no temp file, no shell quoting — the
   config travels over the existing agent channel. Security-wise this adds
   nothing `exec` doesn't already grant. Version skew is handled by capability
   advertisement: agents list their post-v0.6.0 message kinds in `identify`
   (`AGENT_CAPABILITIES`), and `HostAgent.httpRequest` fails fast with an
   "update the agent" error for agents that didn't advertise it — instead of
   the silent 30s protocol timeout an ignored message otherwise produces.
3. `POST /load` is atomic: invalid config is rejected wholesale and Caddy keeps
   serving the old one — validation and rollback for free. Error status/body =
   surface as proxy status.

Apply on every route/config mutation (no separate "apply" button), with the
result stored as proxy status.

## Status / feedback

Ingress debugging is most of the pain; SC can check all layers:

- **Proxy**: container state, last apply result, and *why it isn't running*
  when it isn't — `docker inspect .State.Error` (e.g. host-port bind conflict)
  when a container exists, a recent deploy-log tail when a failed `docker run`
  left nothing behind.
- **Per-route**: upstream reachability — HTTP probe from the *proxy node's*
  agent (the vantage point that matters), on apply and periodically. Reuses the
  same `httpRequest` agent primitive as the config push.
- Cert issuance status: later (parse Caddy logs or admin API); v1 shows reload
  result + reachability only.

## Bootstrap caution

SC's own UI may optionally get a route, but direct `:4141` access must always
keep working — a bad proxy config must never lock the operator out of the tool
that fixes proxy configs.

## API + UI sketch

Ops: `getProxyState` (config + routes + status), `setProxyConfig` (+ triggers
deploy when node changes), `createProxyRoute` / `updateProxyRoute` /
`deleteProxyRoute`. Owner/admin-only.

Web: new "Proxy" section — first-run card (pick node, cert mode, ACME email,
Deploy button with detached-deploy progress), then a routes table + add/edit
form. Route rows show enabled state, target, reachability badge.

## Build order

1. State + shared types (`ProxyConfig`, `ProxyRoute`, ops) + the `httpRequest`
   node-protocol message.
2. Deploy flow (labeled container, detached pull, reconcile-by-label).
3. JSON config renderer + push-on-mutation via admin API.
4. Route CRUD handlers + UI.
5. Reachability probes (reuse `httpRequest`).

## Open questions

- Hostname validation strictness (reject wildcards in v1?).
- Whether `certMode: "internal"` should be per-route instead of global once
  mixed public/LAN setups appear.
- Per-node LAN-IP override for multi-homed nodes (punted).
