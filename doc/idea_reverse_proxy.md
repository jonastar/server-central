# Reverse Proxy (v1)

Status: v1 implemented 2026-07-13 (`apps/server/src/features/proxy/`, `httpRequest` in the
node protocol, `ProxyView` in the web app). v2 (container targets over a shared
docker network) layers 1–5 implemented 2026-09-12 — see
[v2: container targets](#v2-container-targets-over-the-proxy-network); layer 6
(cross-node tunnel) is designed there and not built. This doc remains the design record. Sibling of
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
   *Done in v2 (layers 1–5 below).*
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

---

# v2: container targets over the proxy network

Started 2026-09-12. The v1 route model asked the operator for a *published host
port*, which forces every proxied app to also be reachable directly on the LAN,
and makes "assign a route" a two-place edit (compose `ports:` first, route
second). v2 lets a route target a compose **service** on a shared docker network
instead: no host port, Caddy dials the service by name, and the UI picks the
port from the compose file rather than asking for a number.

It is several layers, built bottom-up. Each is shippable alone.

## Layer 1 — the network (done)

`PROXY_NETWORK = "sc-proxy"` (shared, `domain/proxy.ts`), named like the
container and its volumes. The deploy chain in `caddy.ts` creates it
idempotently (`docker network inspect … || docker network create …`) before
`docker rm -f` of the old container, and the `docker run` joins it with
`--network sc-proxy`. Publishing works from any network, so the container needs
no other. The network is never removed: stacks reference it as `external`, and
tearing it down would break them.

Existing installs pick this up on the next Deploy (the run command changed).

## Layer 2 — the route target model (done)

`ProxyRouteTarget` is a discriminated union:

```ts
type ProxyRouteTarget =
  | { kind: "hostPort";  nodeId; port; scheme; insecureSkipVerify? }
  | { kind: "container"; nodeId; stackId; service; alias; port; scheme; insecureSkipVerify? }
```

- `hostPort` is v1 unchanged: Caddy dials `<node LAN IP>:<port>`, from any node.
  Still the only way to reach an app SC doesn't manage as a compose stack.
- `container`: `port` is the **container-side** port; Caddy dials
  `<alias>:<port>` over `sc-proxy`. `stackId`/`service` are provenance for the UI
  (linking, drift checks); the renderer reads `alias` alone.

**The alias is stored, not derived.** Compose aliases every service by its bare
name on every network it joins — external ones included — so two stacks with a
`web` service on `sc-proxy` would round-robin under `web`. SC therefore writes
an explicit `<project>-<service>` alias (`proxyNetworkAlias()`) into the
service's `networks` block when attaching it, and the route carries that exact
string. Deriving it at render time would need the compose store inside the
proxy feature, and would make a renamed project silently re-point the route;
storing it makes the rename show up as a route that can't connect — visible,
not magical.

Persisted routes from before `kind` existed are migrated to `hostPort` on load.

**Validation refuses what the renderer can't serve.** The Caddy config is
pushed as one document, so one unrenderable route takes every route down. The
store therefore rejects, at save time, a `container` target on any node other
than the proxy node (until layer 6 exists), and rejects moving the proxy while
container routes would be stranded on the old node. Tests:
`proxy-caddy.test.ts`, `proxy-store.test.ts`.

## Layer 3 — compose file mutation (done)

`composeDoc.ts` (`apps/web/src/lib`, tests in `apps/web/test`):
`attachToProxyNetwork(doc, service, alias)`, its inverse
`detachFromProxyNetwork`, and the readers `serviceProxyAlias` /
`serviceProxyPorts`. Attaching:

- adds top-level `networks: { sc-proxy: { external: true } }`
- sets the service's `networks` to `{ default: {}, sc-proxy: { aliases: [alias] } }`

The `default: {}` entry matters: the moment a service declares `networks:` it
silently drops off the stack's default network unless that is listed too, and
its links to sibling services break. A list-form `networks:` becomes the map form
(an alias only fits there) with the author's entries intact; `network_mode`
services are refused (route to a host port instead). Applying is the existing
`docker_compose_action` task, `up` scoped to the one service.

Deleting a route does **not** detach the service: another route may target it,
and re-adding one shouldn't recreate the container. `detachFromProxyNetwork`
is there for an explicit "leave the proxy network" action later.

On a non-proxy node the network doesn't exist yet — the attach flow will have to
create it there too (same idempotent command) when layer 6 lands; until then
the modal never attaches off the proxy node.

## Layer 4 — port semantics (a rule for layer 5, not a step; followed)

Over the shared network Caddy can dial *any* port the container listens on;
`ports:` is irrelevant to it. But a compose `ports: - "8080"` with no published
side is **not** "not forwarded" — it publishes 8080 on a random host port. The
genuinely unpublished spellings are `expose:` or nothing at all.

So the picker's candidates for a `container` target are `ports[].target`
(labelled by the compose `name` field `PortRow` already preserves) plus
`expose[]`; for a `hostPort` target they are `ports[].published`. Both keep a
"custom port" escape hatch. For `container` targets the image's own `EXPOSE`
list (`docker.imageDefaults`, one inspect on the host) fills in after the
compose-declared ports — the normal case on the proxy network is a service with
no `ports:` at all, and then the image is the only thing that knows. The compose editor should not steer an operator
towards adding a `ports:` entry just to make a service proxyable.

## Layer 5 — the picker UI (done)

`ProxyRouteModal.tsx`. The target is a cascade **Node → Stack → Service →
Port**; the port dropdown lists what the compose file declares (`web — 80`,
`8096 (expose)`, …) plus "Custom port…". Kind is derived, never chosen: a stack
on the proxy node yields a `container` target; a stack elsewhere yields a
`hostPort` target picked from its *published* ports (with layer 6 it too becomes
`container`); "Manual host port" is the escape hatch for anything SC doesn't
manage. If the chosen service isn't on `sc-proxy` under the expected alias, the
form says what saving will do — attach it (edit compose.yaml, `compose up
<service>`) — and does it first, then creates the route, so a failed `up`
leaves no route pointing at nothing.

Second entry point: **"Expose via reverse proxy…"** in a service row's action
menu on the stack page, opening the same modal with node/stack/service
pre-filled. Shown only with `panel.proxy.admin` and a configured proxy. Port
candidates come from the compose file read through the files feature; no new
endpoint.

Not yet: route rows showing drift (service no longer on the network, alias
missing from the compose file, stack down). Editing a route whose stack was
unregistered warns and falls back to a manual host port rather than converting
silently.

## Layer 6 — cross-node container targets: the control-plane tunnel

**This reverses the v1 decision above** ("never the default, last-resort only")
for `container` targets on non-proxy nodes, deliberately and as a *preliminary*
path: routing through SC is fine at homelab scale, and the overlay
([idea_node_overlay.md](idea_node_overlay.md)) replaces it later without
touching the route model. `hostPort` targets are unaffected — they keep dialing
the node directly and stay the zero-overhead cross-node option.

Path: Caddy → SC (TCP listener) → agent channel → agent on the target node →
container.

- **Protocol.** Mirrors the shell session messages: `tunnelOpen {sessionId,
  host, port}` (control→node), `tunnelData {sessionId, data}` and `tunnelClose
  {sessionId}` in both directions, `tunnelOpened`/`tunnelError` as the open's
  reply. Advertised as an agent capability (`"tunnel"`) so an old agent fails
  fast with "update the agent" rather than a protocol timeout. The agent does
  nothing but `net.connect(host, port)` and pipe — it stays as dumb as
  exec/files/http keep it.
- **Resolution.** The agent lives on the host, outside Docker's DNS, so
  `tunnelOpen` carries an IP, not the alias. SC resolves alias → container IP on
  that node's `sc-proxy` network via exec (`docker inspect` of the containers on
  the network, matching `NetworkSettings.Networks["sc-proxy"].Aliases`), caches
  it, and re-resolves on a failed dial — a recreated container gets a new IP.
- **SC side.** One TCP listener per distinct remote target `(nodeId, alias,
  port)`, port allocated from a fixed range and persisted in `proxy.json` so
  Caddy's dial string survives SC restarts. The listener accepts connections
  **only from the proxy node's IP** (checked on `accept`), so the tunnel isn't a
  new LAN-wide bypass. The renderer gets a second resolver alongside
  `resolveNodeIp`: `resolveTunnel(target) → "<SC LAN IP>:<tunnel port>"`, and
  `upstreamDial` uses it for the remote-container case instead of throwing.
  The store's "must be on the proxy node" check goes away with it.
- **Accepted costs** (the reasons v1 said no): SC is a data-plane component for
  these routes — an SC restart drops their live connections, throughput is
  bounded by base64 frames over the agent websocket, and the path is
  proxy→SC→node even when SC sits elsewhere. Backpressure is `pause()` on
  `bufferedAmount`, nothing fancier. All of this is what the overlay removes.
- L4 means websockets and SSE just work; Caddy dials upstreams with HTTP/1.1.

## Build order

1 → 2 → 3 → 5 (with 4 as its rule) — done — → 6. Once layer 6 lands, the modal's
kind derivation changes in one place (`containerKind` in `ProxyRouteModal`),
the store drops its "must be on the proxy node" check, and `upstreamDial` gets
the tunnel resolver.
