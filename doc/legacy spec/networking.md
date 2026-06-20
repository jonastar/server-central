# Server Central — Networking Architecture (Draft Decisions)

This document captures the networking design decisions made for the v1/POC. It extends the base spec in `homelab-hub-spec.md`. Treat these as working decisions, not final — several items explicitly call out what's deferred and why.

---

## 1. Overlay Mesh Network

- The manager auto-provisions a **WireGuard mesh** connecting itself to every enrolled agent. This is invisible to the user — no manual WireGuard config.
- Agents always connect **outbound** to the manager. No inbound ports required on agents, even across NAT.
- All manager↔agent control traffic (gRPC/mTLS) runs over this mesh.

### Topology (v1)
- **Full mesh for now**: every node can reach every other node's mesh IP. This is a deliberate simplification for the POC.
- **Future**: move to hub-and-spoke by default (agents only peer with the manager via `AllowedIPs`), with node-to-node routes added explicitly per-pair when a deploy needs cross-node container traffic.
- **Important caveat**: WireGuard `AllowedIPs` alone does **not** enforce isolation between peers — it's a source-spoofing filter, not a destination filter. A node that controls its own peer config can still route packets to other nodes if the hub (manager) forwards them. Real enforcement must happen in the manager's `FORWARD` chain (nftables/iptables), default-deny between agent subnets, with explicit allow rules per approved pair. This is the mechanism to build when topology moves beyond "flat."

---

## 2. IP Addressing Scheme

### Mesh CIDR
- Default mesh range: **`10.66.0.0/16`** (chosen to avoid common collisions — see below).
- Auto-detection on manager startup / agent enrollment: scan local interface CIDRs + Docker bridge networks on each node, pick first non-overlapping range from a preferred list, fall back to scanning `10.x.0.0/16` for `x` in 50–254.

### Ranges to avoid (common collisions)
| Range | Used by |
|---|---|
| `10.0.x.x`–`10.10.x.x` | Home router defaults |
| `10.8.0.0/16` | Most common WireGuard tutorial default |
| `10.42.0.0/16` | k3s pod CIDR |
| `10.43.0.0/16` | k3s service CIDR |
| `10.88.0.0/16` | Podman default |
| `172.16.0.0/12` | Docker's bridge network pool |
| `10.100.x.x`, `10.200.x.x` | Common SMB management VLANs |

- Alternative considered: `100.64.0.0/10` (CGNAT space, RFC 6598) — what Tailscale uses, guaranteed not to collide with anything by convention. Worth revisiting if `10.66.0.0/16` ever causes friction.

### Allocation within `10.66.0.0/16`
```
10.66.0.0/24    — node host IPs (manager = .1, agents = .2, .3, .4 ...)
10.66.10.0/24   — agent1's "mesh" container network
10.66.11.0/24   — agent2's "mesh" container network
10.66.12.0/24   — agent3's "mesh" container network
... etc
```
- Host IPs: simple sequential assignment, no per-node subnet needed.
- Container subnets: one `/24` per node, only allocated for nodes that opt containers into the mesh network (see §5).
- Each agent's `AllowedIPs` entry (as seen by peers) includes both its host `/32` and its container `/24` so traffic for mesh-joined containers routes correctly.

### Dynamic IPs
- WireGuard's roaming handles agents with dynamic LAN/WAN IPs automatically — manager updates the peer endpoint from the latest handshake source. `PersistentKeepalive = 25` keeps NAT mappings alive.
- The **manager's** address must be stable (DHCP reservation for LAN-only setups, or DynDNS for internet-spanning setups — see §4). This is the one piece of the topology that can't self-heal if it moves.

---

## 3. NAT / Topology Detection

- **NAT detection**: compare each agent's reported local interface IPs (sent at enrollment) against the source IP the manager observes on the inbound connection. Mismatch → behind NAT. No external service needed.
- **Same-LAN detection**: two agents reporting the same external IP are very likely on the same LAN — configure their WireGuard peer `Endpoint` to use each other's local IP rather than routing out and back through the WAN.
- Manager maintains a per-node topology record:
  ```
  Node: agent1
    local_ips: [192.168.1.45]
    external_ip: 203.0.113.42
    mesh_ip: 10.66.0.2
    nat: true
    last_seen_endpoint: 192.168.1.45:51820
    reachable_via: local
  ```
- Surface this on the Network screen: NAT status, current endpoint, staleness warnings, and a warning if the manager itself isn't publicly reachable while remote nodes exist.

---

## 4. DynDNS / External IP Detection

- Needed only when the manager itself needs a stable public name (internet-spanning clusters).
- **Primary**: STUN (e.g. `stun.l.google.com:19302`) — single UDP round trip, returns external IP *and* port, multiple free fallback servers available.
- **Fallback**: HTTP IP-check services (ipify, icanhazip) — fine as secondary, not primary (third-party dependency risk).
- **Optional**: UPnP/NAT-PMP to query the router directly (works without internet access, can also auto-configure port forwarding — but flag this to the user since it modifies their firewall).
- Background loop: check every ~5 min, update DynDNS record on change, log/notify in UI. Warn if checks have been failing for an extended period (cached DNS will eventually expire for remote agents).

### Topologies for internet-spanning clusters
- **Manager has public IP / port forward** — clean case, agents dial out to manager's DynDNS hostname. v1 target.
- **Manager also behind NAT** — requires relay (cheap VPS) or STUN-based hole punching. Deferred; document "manager needs a reachable endpoint" as a v1 requirement.

---

## 5. DNS Naming Scheme

- TLD: **`.internal`** (ICANN-reserved for private networks since 2024 — unlike `.local`, which is mDNS-reserved and breaks on macOS/Avahi).
- Namespaced under product domain, e.g. `sc.internal`:

```
manager.sc.internal                    — control plane, always-known stable name
NODE_HOSTNAME.nodes.sc.internal        — node itself (mesh host IP)
CONTAINER.STACK.stacks.sc.internal     — individual container
```

- **Resolution target for container records**: the container's *own* mesh IP (from its node's `/24`, §2) when mesh-joined — not the node's IP + port mapping. This is what makes the DNS scheme meaningful (direct address, not "ask the node to forward").
- DNS server: embedded in the manager process (~50 lines with `miekg/dns`), answers `*.sc.internal` from its own node/container registry. No external DNS software needed. Bound to the manager's mesh IP only.
- Client-side resolution: WireGuard interface gets `DNS = 10.66.0.1` + a **routing domain** `~sc.internal` (NOT a plain search domain) via systemd-resolved (`resolvectl domain wg0 "~sc.internal"`, or a `.network` file). This scopes only `*.sc.internal` queries to the mesh DNS server — everything else continues using the host's normal resolver.
- Non-systemd-resolved hosts (older distros, NetworkManager, plain `/etc/resolv.conf`): agent needs to detect and handle, or fall back to `/etc/hosts` injection for mesh names.
- Naming sanitization: Docker stack/container names with underscores must be converted to hyphens for DNS labels (`my_stack` → `my-stack`).

---

## 6. Container Networking & Ingress

### Default isolation
- Each stack gets its own Docker bridge network (Compose default) — containers in different stacks **cannot** reach each other by default. This isolation is free, no extra work.
- Cross-stack communication is explicit: via the reverse proxy, or (advanced/discouraged) explicit network attachment.

### Mesh-joined containers (optional)
- A container can optionally join a node's **"mesh" Docker network**, whose subnet is the node's allocated `/24` from §2 (`10.66.10.0/24` etc.).
- Once joined, the container has a directly mesh-routable IP — the kernel forwards `wg0 ↔ mesh-bridge` (requires `ip_forward=1` + appropriate FORWARD rules; Docker's own iptables rules handle bridge delivery).
- **Tradeoff (accepted for POC, flat for now)**: a mesh-joined container can reach the manager and every other node's container subnet — i.e., compromise of one mesh-joined container has network-level reach to the whole mesh. Future mitigation: per-network FORWARD-chain rules (same default-deny + explicit-allow pattern as node-to-node isolation), or carve the mesh into sub-ranges where only same-subnet containers can talk.

### Reverse proxy / ingress paths
1. **Mesh-joined container**: proxy (running on any node) dials the container's mesh IP directly. No agent involvement, single hop. Preferred path — also what makes `CONTAINER.STACK.stacks.sc.internal` resolve to something useful.
2. **Non-mesh container** (stack-isolated bridge, no mesh membership): proxy requests a **forward** from that node's agent over the existing gRPC/mTLS tunnel — agent dials the container's local bridge IP:port and pipes bytes back. This reuses the same bidirectional-stream primitive already needed for terminal/log-tailing (`agent.Forward(target)`), so it's not new infrastructure, just a new use of an existing one.
3. **Direct port exposure** (bypass everything): standard Docker `-p` publish on the node's host interface. Orthogonal to mesh/proxy — UI should clearly warn this exposes the port on the node's LAN/WAN per the user's own router config.

- **Mesh membership is optional** per container — it's a routing optimization (fewer hops), not a requirement for the proxy to function.

---

## 7. Auth / Security Model (brief recap)

- WireGuard mesh + manager-only-reachable management ports means the UI/API don't need to be internet-exposed by default.
- Default: UI bound to LAN + mesh interfaces only; public exposure is opt-in.
- If exposed publicly: require TOTP (not PIN — vulnerable to the same XSS class as session theft) on login and on destructive actions. WebAuthn/passkey as the strong option for SMB use.
- Roles (v1, coarse):
  | Role | Access |
  |---|---|
  | Owner | Everything incl. user management, enrollment |
  | Admin | Everything except user management |
  | Operator | Services, files, terminal — not server enrollment/config |
  | Viewer | Read-only |
- Terminal access should be a discrete, strippable permission — it's effectively root regardless of role.

---

## Open Questions / Deferred

- Hub-and-spoke vs full mesh topology switch, and the FORWARD-chain enforcement that makes it real.
- Per-subnet container isolation within the mesh network.
- Relay support for double-NAT manager scenarios.
- Round-robin vs indexed DNS for scaled/replica containers.
- UPnP-based auto port forwarding — convenience vs. user trust concerns.
