# Node overlay network (WireGuard)

Status: idea / design. Not yet scheduled. Supersedes deferral item 3 of
[idea_reverse_proxy.md](idea_reverse_proxy.md), which had this as "the endgame" —
this doc moves it much earlier and explains why.

## Problem

A reverse proxy route today targets `<node LAN IP>:<published host port>`
([`renderCaddyConfig`](../apps/server/src/features/proxy/caddy.ts),
`resolveNodeIp` in [`manager.ts`](../apps/server/src/features/proxy/manager.ts)).
That means **every app SC proxies must publish a port on its host's LAN address**,
reachable by anything else on that network. You cannot route to a container that
publishes nothing, and there is no way to say "only the proxy node may reach this".

The goal: add a route to another host without requiring that host to expose the port.

## Why this reverses an earlier decision

The original ladder deferred WireGuard to last, behind two cheaper rungs, on the
assumption that an overlay was heavy. Working through the alternatives inverted that.
Two things changed:

1. **Everything short of an overlay needs an abstraction layer that an overlay makes
   unnecessary.** A userspace tunnel needs an upstream-kind abstraction in the route
   model, tunnel allocation on the proxy node, a forwarder, a data-plane protocol,
   a fallback transport, and UI to explain which routes are relayed. With an overlay,
   `resolveNodeIp` returns the overlay address and *nothing else in the proxy feature
   changes at all*. The abstraction layer existed only to hide awkward transports.
2. **The overlay is smaller than it looked.** See "What's in the kernel" below.

What is **not** reversed: the original rejection of tunneling app traffic through SC
still stands, and is strengthened. It stays a last-resort fallback (see §6), never the
primary path — SC must not become a component your apps need in order to serve traffic.

## 1. Alternatives considered and rejected

**Relay app traffic over the node connection.** Simplest to reach (no new host
software) and the reason it loses is the one flagged in the original design: it makes
SC a data-plane component. A control-plane restart drops live connections mid-stream,
and it silently revokes a property the proxy has today — Caddy's `--resume` keeps
routes serving while SC is down. It would also need its own transport: not the control
WS, which is JSON-framed request/response with a 30s `REQUEST_TIMEOUT_MS` and shares
with metrics, terminals and base64 file uploads. Demoted to fallback.

**QUIC as the node transport.** Attractive on paper (stream independence, hole
punching, connection migration) and *not available*: `node:quic` does not exist in Bun
1.3.14 — `require("node:quic")` throws `No such built-in module`. It also can't be a
migration, only an addition: agents must be able to connect over the old transport to
receive the update that teaches them the new one, and UDP is blocked or aggressively
idle-timed on enough networks that a TCP/443 fallback is permanent. Its real value was
NAT traversal for direct agent-to-agent links — which WireGuard provides natively.

**VXLAN.** Worse than WireGuard on every axis that matters here. No crypto and no
authentication whatsoever, so anyone who can send UDP/4789 to a node injects frames
into the L2 domain — a nastier failure than an exposed HTTP port, and it needs
per-node firewall rules to be safe at all. No NAT traversal and no roaming: endpoints
are static FDB entries. 50 bytes of overhead with manual MTU, producing PMTU black
holes that present as "large POSTs hang". And it delivers a broadcast domain when we
need L3 reachability to one port, so we would then own IPAM, bridging and ARP —
i.e. reimplementing Docker's overlay driver, which requires Swarm.

## 2. What's in the kernel (the load-bearing fact)

`wireguard.ko` **is the entire protocol**: the Noise_IKpsk2 handshake, Curve25519,
ChaCha20-Poly1305, BLAKE2s, cookie DoS mitigation, rekey/keepalive timers, the
cryptokey-routing trie, and encap/decap. `wg` is *only* a configuration client — it
sets keys, listen port and peers over netlink, then exits. **No application traffic
ever passes through userspace, and there is no daemon.**

Consequences that make this cheap for us:

- **Nothing to supervise on a node.** No process to crash, restart or leak. The tunnel
  survives the agent dying, the agent self-updating, and SC being down entirely.
- **The kernel initiates handshakes**, lazily, when there's traffic and no valid
  session. SC installs peer info; there is no mesh-bringup sequence to half-fail.
- **Roaming is free and covers most NAT cases.** A peer's endpoint is updated from the
  source address of any packet that authenticates. If *one* node is reachable, nodes
  behind NAT reach it and it learns their addresses; `PersistentKeepalive = 25` holds
  the mapping open. The residual hard case is two NATed nodes at different sites with
  no reachable node anywhere — much smaller than "NAT" in general.
- **Kernel-native throughput** — no per-packet userspace round trip.
- **Config is runtime state, not a file.** It lives in the kernel and is gone on
  reboot. That suits us: the agent reapplies on connect, SC stays the single source of
  truth, no file on disk to drift. Same philosophy as the proxy's "no config file on
  the host at all". No bootstrap loop, since agents dial SC over the normal network.

Availability is good: `CONFIG_WIREGUARD=m` on stock Debian 13 (mainline since 5.6).

### Tooling: `wg` and `ip`, not `wg-quick`

`wg-quick` is a shell script doing six things; five are rtnetlink and `ip` already does
them — and `ip` is present on every Linux host, whereas `wg` usually is not:

```sh
ip link add wg-sc0 type wireguard      # create (auto-loads the module)
ip addr add 10.x.y.z/32 dev wg-sc0
ip link set wg-sc0 up mtu 1420
wg syncconf wg-sc0 <path>              # keys + full peer set
```

The rest of `wg-quick` (DNS, fwmark, kill-switch routing, auto-derived routes,
save/restore) we do not want; several of those actively fight a control plane that owns
the config.

**`wg syncconf` is the reconcile primitive** — it makes the interface match a full peer
set, adding, updating *and removing*, without touching the interface or dropping live
sessions. It is the exact analogue of Caddy's atomic `/load`, and it is part of `wg`,
not `wg-quick`.

Two handling notes: `syncconf` takes a file path, so the agent writes a temp config —
put it in tmpfs, mode 600, unlink after, or keep the key out of the file entirely with
`wg set <if> private-key /dev/stdin`.

### Talking to netlink directly (considered, not now)

Feasible: `bun:ffi` opens an `AF_NETLINK` socket fine, and keygen needs no FFI at all —
WebCrypto does X25519, where the raw public key is `exportKey("raw")` (32 bytes) and the
private key is the last 32 bytes of the PKCS8 export. What remains is `WG_CMD_SET_DEVICE`
/ `WG_CMD_GET_DEVICE` on the `wireguard` generic-netlink family: a few hundred lines with
real sharp edges (dynamic family-id resolution via `CTRL_CMD_GETFAMILY`, `NLA_ALIGN`
nesting, splitting large peer sets across messages — a bug that stays hidden until ~20
nodes — multipart `GET` dumps, raw `sockaddr` encoding).

Not worth it yet. It buys only the removal of a package dependency, and if that becomes
urgent (appliance NASes with the module but no usable package manager) the cheaper answer
is to ship a static `wg` binary through the mechanism that already ships the agent
([`binary-store.ts`](../apps/server/src/binary-store.ts)).

## 3. Step 1 — WireGuard visibility feature

A per-host feature in the existing registry, same shape as zfs/systemd/docker. Useful on
its own: plenty of hosts already run a road-warrior tunnel or a link to a VPS, and
"is the handshake recent" is exactly the thing you currently SSH in to check. It also
builds the primitives step 2 needs, with SC reading instead of writing.

- Add `"wireguard"` to `HostCapability` ([`shared/src/index.ts`](../shared/src/index.ts)).
  `assertHostProbeCoverage` ([`feature.ts`](../apps/server/src/feature.ts)) then fails the
  build until a feature claims it — the type system walks the addition through.
- The probe must distinguish, in `detail`, module-present-tools-missing ("install
  `wireguard-tools`") from module-absent, exactly as the zfs probe distinguishes a binary
  from a usable kernel module. Manual install for now; package-manager integration later
  slots in behind the same probe without changing anything above it.
- Parse `wg show all dump` — machine-readable and stable: one line per interface, then one
  per peer. Surface pubkey, listen port, endpoint, allowed-ips, last handshake, rx/tx,
  keepalive. Handshake age is the health signal (older than ~3 min with traffic expected
  means it isn't working).
- **The interface line's first field is the private key.** (This is why plain `wg show`
  prints `private key: (hidden)`.) Strip it in the agent at parse time so it never enters a
  response type — [node_security_model.md](node_security_model.md) §b.3 flags node responses
  reaching the operator's browser as the sharpest escalation path.
- Probably **zero write operations**: existing tunnels are typically `wg-quick@wg0` systemd
  units, so start/stop/enable and unit-file viewing already come from the systemd feature.
- Step 1 must **not** write config files. Step 2 deliberately owns runtime state with no
  file on the host; teaching users to expect SC-written `/etc/wireguard/*.conf` would have
  step 2 contradict its own predecessor.

## 4. Step 2 — SC-managed overlay

Structurally identical to `ProxyManager`: render config from state, push to the node,
reconcile on change.

**Ownership marker — decide before shipping step 1.** WireGuard has no label or comment
field; kernel state is keys, endpoints, allowed-ips and counters. There is nowhere to stamp
`sc.managed=1` the way the proxy container carries `sc.proxy=1`. **The interface name is the
only durable handle**, so it carries the meaning: SC manages `wg-sc0` and nothing else.
Everything else is foreign and read-only. Renaming later means migrating live tunnels.

- **Keys**: generated on the agent; the private key never leaves the host. Public key
  travels up the existing channel.
- **IPAM**: a `/32` per node from an SC-chosen `/24`, stored alongside proxy state.
  `AllowedIPs` is the peer's single `/32` — no forwarding, no NAT, no default-route
  hijack, no `ip rule`. The boring configuration.
- **Endpoints**: the LAN/WAN addresses SC already tracks (`primaryIp` / `remoteIp`), plus
  the per-node STUN check in [`stun.ts`](../apps/server/src/stun.ts). Roaming (§2) covers
  the rest.
- **Reconcile**: re-render and `wg syncconf` on membership change and on agent connect.
- **Proxy integration**: `resolveNodeIp` returns the overlay address. `renderCaddyConfig`,
  the route model, and the UI are untouched. Published host ports can then be dropped, or
  bound to the wg interface address only.
- **Opt-in, with its own UI.** This mutates host network configuration fleet-wide; it should
  not be something enrollment silently switches on. Same posture as ZFS's no-silent-`-f`.

## 5. Platform notes

- **Linux**: as above. The primary and only target for step 2 initially.
- **Windows**: the official installer ships `wg.exe` *and* `wireguard.exe`. The model
  differs — there is no `ip link` equivalent, so adapters are created by installing a tunnel
  *service* from a `.conf` on disk (`wireguard.exe /installtunnelservice <path>`), backed by
  the WireGuardNT driver, and `wg.exe` talks to a per-tunnel named pipe rather than netlink.
  So Windows needs a config-file-driven path where Linux gets an imperative one.
  **Unverified:** whether live `wg set` peer updates work as cleanly there as on Linux — the
  blessed update path is rewriting the `.conf` and restarting the service. Test on a real box
  before designing around it. Low priority regardless: Docker on Windows means Docker Desktop
  or WSL2, which makes "proxy upstream on a Windows node" murky anyway.
- **macOS**: `wg` backed by `wireguard-go` on a `utun` device. Here `wg-quick` *is* needed —
  `wg` alone cannot create the interface.
- **No kernel module**: `wireguard-go` / `boringtun` implement the full protocol in userspace
  against a TUN device — slower, same wire protocol, interoperable. So the capability probe
  should pick an implementation rather than treating "no module" as "no overlay".

## 6. Fallback: userspace relay

Build only if hosts or topologies turn up that WireGuard genuinely cannot reach — the two
known candidates being unprivileged LXC without `NET_ADMIN`, and two NATed nodes at different
sites with nothing reachable between them. Shape if it happens: the proxy node's agent
presents a local socket, Caddy dials `127.0.0.1:<allocated>`, and the transport underneath
sits behind a narrow `openTunnel(nodeId, port) -> duplex` interface. One QUIC or WS stream
per *TCP connection*, not per request — after Caddy dials, there are no request boundaries to
see without terminating HTTP, which would break upgrades.

Surface relayed routes as relayed in the UI: they depend on SC's uptime, and every other
route does not.

## Build order

1. `sc-proxy` shared docker network (same-node, no published ports) — independent of all of
   this and worth doing regardless.
2. WireGuard visibility feature (§3) — read-only, capability-gated. Settle the `wg-sc0`
   naming convention here even though nothing writes yet.
3. SC-managed overlay (§4) — brokered keys, IPAM, `wg syncconf` reconcile, `resolveNodeIp`
   returns overlay addresses.
4. Userspace relay (§6) — only on demand.

## Open questions

- Full mesh, or hub-and-spoke through the proxy node? Full mesh is `n²` peer entries but
  needs no relay hop; hub-and-spoke is fewer entries and fewer NAT problems, but puts the
  proxy node on the path for node-to-node traffic that isn't proxy traffic.
- Does the overlay serve anything besides proxy upstreams (agent transport itself, cross-node
  file copy, backups)? If yes, it stops being a proxy feature and becomes cluster
  infrastructure — which argues for its own top-level section rather than living under Proxy.
- Whether published host ports should be *removed* or merely rebound to the wg address when a
  route moves onto the overlay. Removing is tighter; rebinding is reversible.
