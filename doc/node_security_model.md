# Node security model & threat assessment

Status as of 2026-06-27. Verdict: **good enough for testing on a non-critical stack, not yet
hardened for hostile internet exposure.** Known gaps are listed under "Work to do".

## Architecture: the direction is inverted

Nodes are **outbound** WebSocket clients. The agent dials the control plane
(`wss://host:4142/node`, `agent-cli.ts`) and the control plane sends it commands. A node never
opens an inbound port.

- There is nothing to expose *on a node*. A node you want "separated" simply must not be able to
  reach `:4142` (don't enroll it, or block the outbound path).
- The only listener is the **control plane's node server on `:4142`** (`node-server.ts`), separate
  from the web/API port `:4141` (`index.ts`).

## Protocol authority is one-directional (the good news)

The control plane sends `ControlMessage`s to nodes; nodes only send responses / metrics /
`identify` back (`node-protocol.ts`). Consequences:

- A rogue/compromised node **cannot issue commands to other nodes.**
- It **cannot exec on the control-plane host** — the embedded agent has no inbound path from nodes.
- So there is no direct node→node or node→control-plane RCE pivot. The embedded agent (fleet rank
  `embedded`) also cannot be displaced.

## a) Is it safe to expose `:4142` to the internet?

It is *designed* to be (STUN WAN discovery, external-host endpoints, TLS leaf SANs cover WAN
IP/domain). Crypto hygiene is decent: CA-signed leaf, curl `--pinnedpubkey` on bootstrap, agents
trust the CA not the leaf. Enrollment tokens are 122-bit UUIDs with a 30-min TTL — infeasible to
guess.

Gaps before it is *safe* against a hostile internet:

1. **No rate limiting / connection caps on `:4142`.** Unlike `:4141` (login throttle in `auth.ts`),
   anyone can open unlimited WS connections; each valid `identify` allocates a `HostAgent` in an
   unbounded map. Cheap memory/DoS amplifier, no per-IP cap on the unauthenticated handshake.
   **Main thing to fix before wide exposure.**
2. **Tokens aren't bound to anything.** `validateToken` only checks "known and unexpired"
   (`node-server.ts`) — not tied to a machineId, IP, or fingerprint. Any leaked token is fully
   portable.
3. **No token revocation.** Durable tokens never expire and there's no kick/rotate path. A leaked
   durable token is good forever until `agent-tokens` is hand-edited.
4. `/node-cert` serves the CA publicly/unauthenticated — fine by design, but fingerprints the
   instance.

TLS/pinning is solid; the weak spots are **abuse-resistance and credential lifecycle**, not
eavesdropping.

## b) Worst a compromised node (or leaked token) can do

1. **Impersonate and displace another host (the sharpest risk).** On `identify` the node supplies
   its own `machineId`, `hostname`, `info`, `mode` — trusted verbatim (`node-server.ts`). Tokens
   aren't bound to a machineId, so one valid token lets an attacker claim to be *any* machine. Fleet
   priority is `live < installed < embedded`, newer-wins-on-tie (`fleet.ts`). A rogue connection
   claiming `mode: "installed"` with a real node's machineId becomes the **active** agent and demotes
   the legitimate one to standby — so operator shell/exec/file-browse against that host silently
   lands on the attacker's machine. (Cannot displace the embedded agent.)
2. **Token theft → durable persistence.** An installed agent's durable token + cert live in
   `dataDir/config.json` (`agent-cli.ts`). The token never expires and isn't IP-bound, so an
   attacker can reconnect from anywhere — even after the host is cleaned — until it's rotated by
   hand. Combined with (1) = durable fleet hijack.
3. **Lie in responses / poison the operator's browser.** A compromised node controls every
   `*Response`. Fake metrics/info is low-severity. Sharper: `readFile` returns SVG as base64 with
   `mimeType: "image/svg+xml"` (`agent.ts`). If the web UI renders that inline, a malicious node can
   serve a scripted SVG → **XSS in the operator's session**, whose token lives in localStorage
   (`auth.ts`). That would escalate a single compromised node to full control-plane (whole-fleet)
   compromise — the one path that breaks the "can't pivot to other nodes" guarantee.
4. **DoS the control plane** — flood large metrics frames / many connections (per a.1).

## Work to do (to reach 100%)

- [ ] Bind tokens to a machineId at mint time; reject `identify` whose `machineId` doesn't match
      (kills b.1 and most of b.2).
- [ ] Add connection / rate caps on `:4142` (kills a.1 / b.4).
- [ ] Add token revocation + treat a durable-token leak as the real threat model.
- [ ] Verify the file-preview renderer sanitizes/sandboxes SVG (kills b.3).

## Current testing posture

Acceptable for deploying to a **non-critical project stack** for testing, especially if `:4142` is
reachable only over LAN/VPN rather than the open internet. Do **not** rely on it as
hostile-internet-hardened until the items above are done — primarily the rate/connection caps and
the machineId↔token binding.
