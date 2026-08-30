# Proxy auth gateway (forward auth, roles, SSO)

Status: idea / design. Not yet scheduled. Nothing here is decided — every section
carries options and the questions that pick between them.

Fills deferral item 4 of [idea_reverse_proxy.md](idea_reverse_proxy.md)
("`forward_auth` role gating on routes"), and consumes Part 1 of
[idea_rbac_host_users.md](idea_rbac_host_users.md) (control-plane RBAC), which is
its hard prerequisite. Sibling of [idea_node_overlay.md](idea_node_overlay.md):
the overlay is what makes a gated route actually un-bypassable, see §9.

## Goal

Expose self-hosted apps (Immich first) to the open internet without putting every
family member behind a VPN, and without trusting each app's own login screen as the
only thing between the internet and their data.

The mechanism: SC's managed Caddy authenticates the request **before** any bytes reach
the app. An unauthenticated request never touches Immich — not its login form, not its
password reset, not whatever CVE its API had last month. The app's own auth still runs
afterwards (via SSO against SC), so a hole in SC's gate doesn't hand over the app either.
Two independent gates, not one.

### Threat model, stated plainly

- **In scope:** the app's own auth stack is untrusted. Pre-auth code paths, unauthenticated
  API surface, and auth-bypass bugs are all assumed exploitable, and are all unreachable
  from the internet because Caddy answers 302 first.
- **In scope:** account segregation. A family member with a photos account must not be
  able to reach the control plane, read `/etc/shadow` through the file browser, or open
  a root terminal. Today they can — see §1.
- **Out of scope:** a compromised proxy node, a compromised control plane, and a hostile
  actor already on the LAN (partly — §9).
- **Explicitly accepted:** a user who *has* passed the gate can attack the app behind it.
  The gate is a filter on *who*, not a WAF.

## What exists today

Grounded in the code, because three of the five pieces are half-built already:

| Piece | State |
| --- | --- |
| Reverse proxy | Works. One Caddy on one node, JSON config pushed to the admin API. [`caddy.ts`](../apps/server/src/features/proxy/caddy.ts), [`manager.ts`](../apps/server/src/features/proxy/manager.ts) |
| OIDC provider | Works for the happy path: code + PKCE/S256, RS256, discovery, JWKS, userinfo. [`features/oidc/`](../apps/server/src/features/oidc/) |
| Roles | `owner \| admin \| operator \| viewer` exists on `UserInfo` and is enforced **nowhere** except `requireOwner` on user/OIDC-client admin ops. §1 replaces this with permission nodes. |
| Sessions | Opaque 256-bit bearer tokens in `localStorage`, server side in `sessions.json`. **No cookies anywhere in the codebase.** |
| Forward auth | Nothing |

The last two rows are the ones that hurt. Read them together: there is currently **no
credential a browser will present to `photos.example.com`**. The session lives in
`localStorage` on SC's origin, which is invisible to every other hostname by
construction. Forward auth is not "add a handler" — it needs a new kind of credential
first. That's §2, and it's the piece with the most design left in it.

## The five pieces, in dependency order

1. **Permissions v1** — one dotted namespace where `panel.*` and `app.*` are separate
   worlds, so "can open the photos app" stops implying "can use the control panel".
2. **The gateway session** — a cookie a browser will actually send to `photos.example.com`.
3. **The verifier** — who answers Caddy's auth subrequest, and what happens when it's down.
4. **Config generation + route groups** — the renderer and the data model behind it.
5. **Closing the SSO gaps** — so the second login is automatic instead of annoying.

---

## 1. Permissions v1

### The shape problem

The existing ladder (`owner | admin | operator | viewer`) can't express the thing this
feature is entirely about. Grandma needs an account that can sign into Immich and *nothing
else*. The lowest rung today, `viewer`, sees the whole fleet: every host, every container,
every metric. And because per-op enforcement doesn't exist yet, in practice she'd get a
root shell.

### The model: dotted permission nodes

**Implemented 2026-08-29** (`shared/src/permissions.ts`, `Feature.opPermissions`, enforcement in
`index.ts`'s dispatcher). One namespace of dotted permission strings held per user, with prefix
wildcards, replacing the ordered ladder as the enforcement primitive. What shipped matches the
design below, with `app.*` inert until §4 gives it a consumer. Still open from this section: the
per-host scoping question, UI gating, and per-task-kind nodes — tracked in `next.md`.

```
panel.terminal
panel.docker.read
panel.docker.write
panel.zfs.write
panel.users.admin

app.immich.user
app.immich.admin
app.jellyfin.user
```

This supersedes the two-field sketch this doc originally carried (a control-plane role
*plus* a separate group list). The prefix **is** the axis, which is the same separation
with one storage shape, one matcher, and one UI widget instead of two of each. It also
delivers the "app-provided roles" idea recorded in the 2026-07-02 changelog note: SC never
learns what `app.immich.admin` means, it just carries the string into the `groups` claim
and Immich maps it with its own claim configuration.

The two halves have deliberately **different rules**, and that asymmetry is the point:

- **`panel.*` is a closed set.** Every node is declared in code (below). Unknown nodes are
  a bug, the UI can render the whole tree, and "what can this user do" is enumerable.
- **`app.*` is open.** SC cannot know another app's role names, so these are free strings
  (or per-client registered strings — see the questions). Nothing in SC enforces them;
  they are payload for the RP and matcher input for the proxy gate.

### Matching semantics

Small enough to state completely, which is the idea — this function is the security kernel
and wants unit tests before it has callers:

> A held permission matches a required one if they are equal, or if the held one ends in
> `.*` and the required one starts with the held prefix. `*` alone matches everything.

Prefix wildcards only. **Suffix and mid-pattern globs (`*.admin`) are deliberately not
supported.** They are tempting — "admin in everything" is a real thing to want — and the
cost is high: matching stops being a prefix test and becomes a glob engine, the set a user
holds stops being enumerable without walking the whole registry, and the permission tree
can no longer be rendered or diffed. Keep `.read` / `.write` / `.user` / `.admin` as a
**naming convention** — consistent leaf names across panel features and across apps, worth
writing down and holding to — but not as something the matcher understands.

Grant-only. No negation entries (`-panel.terminal`). Every system of this shape eventually
grows them, and they bring precedence rules (longest match? deny-always-wins?) that make
"what can this user do" unanswerable by inspection. Saying no now is much cheaper than
saying no later.

### The wildcard's sharp edge

Wildcards bind late: a user granted `panel.*` today silently gains `panel.zfs.destroy`
when that node is added tomorrow. That is the intended semantic, and it inverts the safety
property that per-op enforcement otherwise gives — an operation nobody has classified yet
should fail closed and get noticed, not ship open.

Three ways to keep both:

**Option A — expand at grant time.** `panel.*` is stored as the concrete node set it
covered when granted. Fully explicit, zero late binding, and it throws away most of what
made the wildcard worth having.

**Option B — only `owner` holds `*`.** Everyone else is explicit. Simple, and it makes
"give this admin everything except terminals" tedious enough that people won't.

**Option C — sensitive nodes are wildcard-excluded.** A node can be marked `sensitive`; no
wildcard covers it and it must be granted by name. `panel.terminal` and `panel.users.admin`
are the obvious first two — the ones where "I didn't realise they had that" is a real
incident rather than a surprise.

**Leaning:** C. It keeps the convenience where the blast radius is small and removes it
exactly where it isn't. Independently, an operation with **no declared node at all** must
deny for everyone including `*` holders — undeclared is a bug, not a grant.

### Most write permissions are implicitly root, and the registry says so

The agent runs as root, so a permission's blast radius is routinely larger than its name
suggests: `panel.files.write` reaches `/etc/sudoers.d`, `panel.compose.write` writes container
definitions that can bind-mount `/`, `panel.settings.admin` replaces the control plane's own
binary, and `panel.files.read` reaches SC's data directory — session tokens and the agent
enrolment token included.

Each such node carries an `escalation` string saying *how*. The string is the mark; there is no
separate boolean, because "which permissions are secretly root" has no useful answer that isn't
the route itself. The role editor sums it per bundle ("grants root on managed hosts, through 6
of its permissions"), since that's a property of the whole role and the individual marks are
easy to scroll past.

The first thing this surfaced was in the seeded roles themselves: `viewer` held
`panel.files.read`, so "read-only across the fleet" included reading SC's own data directory —
session tokens and the agent enrolment token, which is enough to act as another user. The
viewer role now grants **no marked permission at all**, which is the property that makes a
read-only tier worth having, and there's a test asserting it stays that way. Host inventory
(mounts, mappable devices) split out as `panel.mounts.read` so the tier keeps what was never
the problem; the file browser is an explicit grant.

`escalation` is a **different axis from `sensitive`** and deliberately doesn't imply it.
Sensitive means a wildcard must not reach this — it's about grants nobody intended. Escalation
is a consequence of a grant someone did intend. Making every root-equivalent node
wildcard-exempt would leave `panel.*` granting almost nothing without making anyone safer.

This is also why docker splits three ways rather than one `write`: restarting a container
someone else defined is not the same act as instantiating a definition of your own.
`panel.docker.control` is lifecycle, `panel.docker.deploy` is instantiation (marked),
`panel.docker.prune` is destruction. Worth knowing that SC has no "run arbitrary container"
operation at all — creation happens only through a compose stack, which is why
`panel.compose.write` is the sharpest edge in the docker story rather than anything named
"docker".

### Where this model is deliberately incomplete

Two gaps, both accepted for now, both recorded here so the next person doesn't mistake them
for oversights.

**Escalation is documented, not bounded.** Every action runs as the agent's user, which is
root, so the marks describe a hazard rather than contain it. The real fix is Part 2 of
[idea_rbac_host_users.md](idea_rbac_host_users.md): run file operations, `exec`, docker and
systemd as the Server Central user's *mapped host account*, so what a permission reaches is
bounded by ordinary OS permissions rather than by a sentence in a registry. Three
complications worth knowing before anyone starts:

1. **The marks become conditional.** `panel.files.write` is root-equivalent only when the
   holder maps to a privileged account; mapped to `deploy`, it reaches what `deploy` reaches.
   So `escalation` stops being a property of the node and becomes a property of
   (node × user × host) — which the UI can't state as flatly as it does today.
2. **Docker doesn't benefit.** Membership of the `docker` group is root-equivalent by
   construction: the socket will run a container that mounts `/`. Mapping a user changes
   nothing for `panel.docker.*` unless the host runs rootless Docker, so the sharpest
   escalation in the set is the one host-user mapping doesn't fix.
3. **Some operations legitimately need root** — installing an agent, writing a systemd unit,
   `zpool` — so the agent can't simply drop privileges wholesale. It becomes a per-operation
   decision about which identity to act as, which is a bigger change than it first looks.

**Degrees of control, and the audit trail they need.** Not every boundary has to be a wall.
A key on a manager's desk is a real control: it is obviously not yours to take, and taking it
has consequences. Several permissions here fit that shape better than a hard technical
boundary — `panel.files.read` reaching Server Central's own session tokens is a policy problem
as much as a mechanism problem, and the mechanism fix (bounding reads by OS permissions)
doesn't exist yet.

Adopting it would mean grading the marks rather than making them binary: *bounded by OS
permissions* / *discloses credentials* / *root by construction* are three genuinely different
things currently all rendered as "root".

The prerequisite is the part that doesn't exist. "You will be caught" requires that you can
be caught, and Server Central's audit trail today is partial: task runs record the user who
started them (`runTask` stores `userId`), and nothing else does. File reads, terminal
sessions, and every other API call leave no record — including, precisely, the node that
prompted this discussion. A graded model without an audit log is a label that says "we would
have noticed", when we would not have. So the order is: audit log first, degrees second.
Both are open questions in this doc and in
[idea_rbac_host_users.md](idea_rbac_host_users.md); neither is scheduled.

### Roles are editable bundles, and users hold several

**Decided 2026-08-30.** A role is a named bundle of nodes, stored in the control plane and
editable; a user holds any number, and their grants union. Union needs no precedence rules —
that falls straight out of the model being grant-only, which is most of what that decision
bought. `owner` stays outside the system entirely as a flag: a role you can remove from
yourself is a lockout waiting to happen. "No roles" is then the floor, which retires the
`none` placeholder.

Built-ins are **seeded, not code-defined**: written once on first run, owned by the
installation after. The reasoning is the user's and it's the same shape as the sensitive-node
rule — an update must never silently widen a role someone already holds. The cost is the
mirror image: a node added in a later release reaches nobody and nothing says so. That's
answered by `unassignedPermissions`, surfaced on the Roles screen as "N permissions are in no
role", so a new capability is discovered deliberately rather than never.

They're named "Control panel viewer/operator/admin" because the namespace has two halves, and
an installation will grow roles that grant only `app.*` to people who never open the panel.

Editing roles needs `panel.roles.admin`, sensitive and in no seeded role: anyone who can
define a role can define one granting everything and assign it to themselves. Assigning
existing roles is `panel.users.admin` — a different power, a different node.

### Roles survive as bundles (superseded by the above)

Permissions are the enforcement primitive; roles become named, editable **bundles** of
them. Users hold roles (and, if useful, ad-hoc extra nodes). This is not a compromise —
it's what keeps the Users screen from becoming a forty-checkbox tree, keeps the existing
`updateUserRole` path meaningful, and gives the migration a shape: `viewer`, `operator`,
`admin` ship as preset bundles matching roughly what they imply today.

Open: are preset bundles editable by the owner, or fixed, with custom bundles created
alongside? Editable-with-presets is friendlier and makes "what does operator mean here?"
a question with an install-specific answer.

### Where panel nodes are declared

Same recommendation as before, now carrying permission strings instead of a role: a
`Feature.opPermissions` member alongside the existing `ownerOnlyTaskKinds`, composed by
[`feature.ts`](../apps/server/src/feature.ts)'s `mergeSlices`. This codebase already proves
at compile time that every operation has exactly one handler; the same machinery proves
every operation declares exactly one permission node, and **the union of declared nodes is
the registry** — which is what lets the UI render a real tree instead of a text box, and
what makes an unknown `panel.*` string detectable as a typo.

**Reversed 2026-08-30.** Per-feature declaration was built first and then replaced by a
central, node-first registry in `shared/src/permissions.ts`:

```ts
"panel.zfs.admin": {
    label: "Pool & vdev surgery",
    description: "Create, destroy, import and export pools, add vdevs, replace devices…",
    ops: [], tasks: ["zfs_pool_create", "zfs_pool_destroy", …],
}
```

Three reasons it wins, in order of weight:

1. **The things it classifies are already central.** `CentralApiOperations` and `TaskSpec`
   live in shared; a feature owns the *handler*, not the operation's existence. Annotating a
   central registry centrally is the consistent placement, not the exception to it.
2. **The UI can explain a grant.** The web app reads the same registry, so the grants editor
   lists every node with what it actually does and whether it's wildcard-exempt. A per-feature
   map on the server could never reach the browser, and a hand-written second copy would drift.
3. **Descriptions have somewhere to live**, next to what they describe.

The cost, which is real: reading `zfs/feature.ts` no longer tells you what gates its
operations. Node names carry that weight instead.

**What must not be lost in the inversion.** `Record<TOps, …>` was total by construction; a
list of operation names is not, and an unclassified operation would reach the dispatcher as
`undefined` — neither `"public"` nor `"authenticated"`, so it falls through to the permission
comparison, which the owner passes unconditionally. The person most likely to be testing sees
it work. Restored with derived checks:

```ts
type UnclassifiedOps = Exclude<ApiOp, ClassifiedOp>;
const _opsAreExhaustive: UnclassifiedOps extends never ? true : UnclassifiedOps = true;
```

That fails the build naming the missing operation (verified by deleting one). Same for task
kinds. Double-classification — two nodes listing one operation — is what `Exclude` cannot
see, so the lookup builders throw on it at module load.

Granularity is a judgement call worth making explicitly: 84 operations must not become 84
nodes. Node granularity should be "a thing a person would think to grant" — roughly
feature × (read | write | admin), so ~15–20 nodes, with many ops behind each.

`runTask` needs the same treatment for the same reason as before: `cmd` runs arbitrary
shell, so per-op permission on `runTask` alone gates nothing unless each task *kind* also
declares a node.

### `owner` stays special

Not "the user holding `*`" — a distinct, undeletable singleton that bypasses the matcher
entirely. Otherwise editing your own permission set is a way to lock yourself out of the
screen where you'd fix it, which is the same class of mistake the bootstrap caution in
`idea_reverse_proxy.md` guards against.

### What reaches the `groups` claim

The claim should carry **only the entries relevant to the client asking** — the
`app.<client>.*` subtree — not the user's whole set. Sending `panel.*` nodes to every
relying party leaks the control plane's internal structure to any app the owner registers,
for no benefit.

### Questions

- Per-host scoping still doesn't fall out of this. An extra segment
  (`panel.host.<id>.docker.write`) is unbounded, keys on ids rather than names, and makes
  every wildcard ambiguous. A separate field next to the permission set
  (`{ node, hosts: "*" | string[] }`) keeps the matcher simple. Or fleet-wide in v1 and
  say so. The dotted model makes people *assume* the segment works, so this needs an
  explicit answer earlier than it otherwise would.
- Who defines the `app.*` namespaces — free text per user, or a per-OIDC-client list of
  role names the owner registers when registering the client? The latter costs a field and
  buys a dropdown instead of a text box, plus typo detection on the half of the namespace
  that has no registry.
- Do app permission strings reach the RP in full (`app.immich.admin`) or prefix-stripped
  (`admin`)? Full is unambiguous; stripped is what some RPs' role mappings expect. Probably
  a per-client toggle, which is one more thing to explain.
- Does the proxy gate (§4) match on the same strings? It should — `requirePermissions:
  ["app.immich.*"]` reusing one matcher is most of the argument for this model.
- Which nodes are `sensitive` (option C above), and is that a code-declared property or an
  owner-editable one? Code-declared is safer; owner-editable invites turning it off.

---

## 2. The gateway session

Caddy's auth subrequest carries the original request's headers. For the browser to have
attached anything useful, SC must have set a cookie the browser considers in-scope for
`photos.example.com`. Three shapes, and they are not mutually exclusive.

**Option A — reuse the SC session token as a parent-domain cookie.**
`Set-Cookie: sc_session=<same token>; Domain=.example.com; HttpOnly; Secure; SameSite=Lax`.
Cheapest possible thing. It is also the worst: **Caddy forwards the original `Cookie`
header upstream**, so Immich's web server would receive SC's admin session token on every
request. That is precisely the trust the whole feature exists to avoid extending. It can
be stripped in Caddy (§4) — but a single renderer bug then leaks control-plane sessions to
every app behind the proxy. Reject on blast radius, not on effort.

**Option B — a distinct gateway session, parent-domain scoped.**
A separate token namespace (`sc_gate_<groupId>`), separate store, minted only by the gate
flow, valid only for the gate. Still visible to apps unless stripped, but a leak buys the
holder access they already had. The route group's cookie domain is what the user described
as "a proxy route group shares the session token" — the group *is* the cookie scope.
One sign-in covers every route in the group. This is Authelia's model.

**Option C — per-host cookies via a ticket handshake.**
Cookie set host-only on `photos.example.com`, so it is never visible to `files.example.com`
or to a hostile subdomain. Costs one extra redirect pair per app on first visit:

```
GET https://photos.example.com/albums
  └─ Caddy → forward_auth → SC: no cookie
     └─ 302 https://central.example.com/gate?rd=…            (SPA gate page)
        └─ 302 https://photos.example.com/.sc-auth/cb?ticket=…  (single-use, host-bound)
           └─ Set-Cookie (host-only) + 302 back to /albums
```

`__Host-` prefixed, no `Domain`, unreachable from sibling hostnames. This is oauth2-proxy's
model. It also survives a hostile or compromised sibling subdomain, which B does not.

**Leaning:** B for v1 with the group as the cookie scope (it matches the described UX and
is the smaller change), C's handshake designed but not built — note that C's ticket flow is
*also* what B needs the first time, so B is the front half of C rather than a dead end.

### The gate page has a wrinkle worth knowing

Step 2 above lands on SC as a **plain top-level browser navigation**, and SC's own session
is a bearer token in `localStorage` — a navigation carries no credential at all. So `/gate`
must be an SPA route that reads `localStorage` and calls an API to mint the ticket. That is
exactly how [`OidcAuthorizeView.tsx`](../apps/web/src/components/oidc/OidcAuthorizeView.tsx)
already works, so the pattern is established rather than new.

The alternative is to **also** set a first-party HttpOnly cookie on SC's own origin at
login. `known_issues.md` records the reason that wasn't done: cookies bring CSRF. That
objection is now much weaker — [`cors.ts`](../apps/server/src/cors.ts)'s
`originAllowsRequest` already refuses cross-origin state-changing POSTs at request level,
which is the CSRF defence. Worth reopening as its own small change; it would also close the
XSS-reads-the-token item in `known_issues.md`.

### Questions

- Cookie lifetime for the gate session — same 30 days as `SESSION_TTL_MS`, or much shorter
  given it fronts the internet? Sliding or absolute?
- Is the gate session a *different session record* from the SC login session, or the same
  record with two presentations? Different records mean "sign out everywhere" has to fan
  out; the same record means revoking an admin session kicks you out of Immich too, which
  may be exactly right.
- Does a gate session survive a control-plane restart? (Sessions persist to disk today, so
  yes for free — unless the design goes stateless/JWT, §3.)
- Do we ever want `SameSite=Strict`? It breaks the redirect-back flow in some browsers.
- Multiple apex domains (`example.com` *and* `example.net`) means multiple groups and no
  shared cookie. Acceptable, or does something need to bridge them?

---

## 3. The verifier — and the availability problem

This is the decision with the longest shadow, because the naive answer makes SC a
**data-plane component**. [idea_node_overlay.md](idea_node_overlay.md) rejected relaying
app traffic through SC for exactly this reason: "SC must not become a component your apps
need in order to serve traffic." Forward auth pointed at SC violates that principle in a
smaller way — SC down means every gated app returns 502.

And it cannot fail open. An auth gate that fails open is not a gate.

**Option A — Caddy calls SC directly.** `forward_auth <sc-ip>:4141`. Nothing new to build
or deploy; full session state, instant revocation, real role checks. Every app request
becomes an SC request, and SC's own self-update task (which kills its own process, see
`next.md`) blips every app in the fleet.

**Option B — stateless signed cookie, verified inside Caddy.** No subrequest at all; Caddy
validates a JWT cookie with a plugin (`caddy-jwt`/`caddy-security`), which needs a custom
image built with `xcaddy`. Apps keep serving while SC is down. Revocation degrades to
"wait for the TTL", so TTLs go short and something must refresh them — which means SC has
to be up periodically anyway, just not per-request. Note the reverse-proxy design already
anticipates a plugin-carrying image variant for DNS-01, so this isn't a new kind of thing.

**Option C — a verifier co-located with Caddy on the proxy node.** SC pushes sessions and
policy to it; it answers subrequests locally. Survives SC downtime *with* revocation. Two
sub-shapes: a **standalone `sc-auth` container** deployed next to `sc-proxy` (reuses every
bit of the existing labelled-container reconcile machinery in `manager.ts`, and is its own
updatable artifact), or a listener on the **agent already installed on that node** (no new
deployable, but the agent dials out over WSS and has no HTTP listener today, so that's a
new local attack surface plus a replication design). Either way there's a container
networking wrinkle: Caddy runs in a container, so `127.0.0.1` isn't the host — it would
dial the bridge gateway (`172.17.0.1`) or need `host-gateway`.

**Decided 2026-08-29:** A as a proof of concept, C (the standalone `sc-auth` container) as
the shape to decouple into once the model is proven. That makes two constraints binding
rather than advisory, because they are what keeps the migration cheap:

- The endpoint must be **independent of the rest of SC's health** — cookie lookup and a
  permission match, no fleet access, no agent round-trip, no disk I/O on the hot path.
  Write it as if it already lived in a different process, because it will.
- The **cookie format and the policy input must be serialisable** — whatever `sc-auth`
  would need pushed to it (sessions, route-group policy, the permission sets) should be a
  clean value, not a reach into SC's live objects. Get this wrong and the decoupling means
  invalidating every live session.

Worth naming the thing that changes when C lands: `sc-auth` holds a replica of live
sessions, so it is a second place credentials live, on the node most exposed to the
internet. That's a real trade against the availability win, not a free upgrade.

### How Caddy reaches SC

Not obvious, and it needs a config field either way. `primaryUrl` sends the subrequest back
out through Caddy itself — it works, but every app request then makes two trips through the
proxy and depends on public DNS resolving from inside the container. Better is a direct
dial to the control plane's LAN address, which SC can resolve when its own host is enrolled
(the `embedded` agent's node id). Question: is that reliable enough, or does this want an
explicit `internalUrl` in `Config` next to `primaryUrl`/`domain`?

### Endpoint shape

A raw HTTP route, not an RPC op — Caddy sends a `GET`, and `/api/` is POST-only with an
`Origin` check that a subrequest won't satisfy. Same shape as `/oidc/token`. It reads
`Host` (preserved by Caddy) plus `X-Forwarded-Uri`/`X-Forwarded-Method` to find the route,
and answers:

- **204/200** — allowed. Response headers `Remote-User`, `Remote-Email`, `Remote-Groups`,
  `Remote-Name` are copied onto the upstream request by `copy_headers`.
- **302** — no session: redirect to the gate with the original URL as `rd`. The redirect
  target must be validated against hostnames SC actually has routes for; an unvalidated
  `rd` is an open redirect, and this one is reachable pre-auth from the internet.
- **403** — authenticated but not a member of the group. Deliberately *not* a redirect;
  bouncing a signed-in user to a login page they'll pass and be bounced from again is an
  infinite loop.

### Questions

- What is the actual per-request cost, and does it need a cache? (Fine at family scale.
  An Immich timeline scroll is a lot of thumbnail requests.)
- Should the gate rate-limit per source, reusing the login throttle's shape?
- Audit: does every gate decision get logged? Every *denial*? Is that the task system's
  job, a real audit log, or `console.log` for now? (`idea_rbac_host_users.md` raises the
  same question for host actions — one answer should serve both.)
- Does SC's own UI go behind the gate? The bootstrap caution in the reverse-proxy doc says
  `:4141` must always work; a gate in front of SC that depends on SC is a lockout waiting
  to happen.

---

## 4. Config generation and route groups

### Data model sketch

```ts
/** A set of routes that share a session, a cookie scope, and an auth policy. */
interface ProxyRouteGroup {
    id: string;
    name: string;
    /** Cookie scope, e.g. "example.com". Every member route's host must be this
     *  or a subdomain of it — otherwise the browser never sends the cookie, and
     *  the user gets a redirect loop with no explanation. Validate on save. */
    cookieDomain: string;
    auth:
        | { mode: "none" }
        | {
            mode: "gate";
            /** Permission patterns (§1) — holding any one grants access, matched by
             *  the same prefix-wildcard function. `["app.immich.*"]` means "any
             *  Immich role". Empty = any signed-in user. */
            requirePermissions: string[];
            /** Identity headers handed to the app after a pass. */
            forwardIdentity: boolean;
            /** Prefixes that skip the gate entirely — health checks, webhook
             *  receivers, ACME. Each one is a hole; the UI should say so. */
            bypassPaths?: string[];
        };
}

interface ProxyRoute {
    // …existing fields…
    /** Ungrouped routes behave exactly as today. */
    groupId?: string;
}
```

Options for how a route joins a group: **explicit assignment** (recommended — boring,
visible), **inferred from a shared parent domain** (magic; adding a route silently changes
another route's security posture), or **per-route policy with no group concept**
(duplicated config, and every app re-authenticates because cookie scopes don't line up).

### Renderer

`forward_auth` is a Caddyfile directive, not a JSON module — SC renders JSON
([`renderCaddyConfig`](../apps/server/src/features/proxy/caddy.ts)), so it emits the
expansion: a `reverse_proxy` handler with `rewrite` to the auth URI, `X-Forwarded-Method`/
`X-Forwarded-Uri` request headers, and a `handle_response` clause matching `status_code: [2]`
that copies the identity headers onto the upstream request. Non-matching responses (the
302, the 403) are returned to the client as-is, which is what makes the redirect work.

Get the shape from `caddy adapt` on a known-good Caddyfile rather than from memory, and pin
it in [`proxy-caddy.test.ts`](../apps/server/test/integration/proxy-caddy.test.ts) — the
renderer tests are already the right place, and this is the highest-consequence JSON in the
codebase.

Three things the renderer must get right, each a real vulnerability if missed:

1. **Strip inbound identity headers on every gated route, before the gate.** Otherwise a
   client sends its own `Remote-User: owner` and — on a bypass path, where no forward_auth
   runs to overwrite it — the app believes it.
2. **Strip the gate cookie before proxying upstream**, so the app never sees it. Caddy's
   headers handler supports regex replace on `Cookie`; a whole-header delete would break
   the app's own session.
3. **Order.** Bypass paths and `.sc-auth/*` must be matched *before* the gated catch-all,
   and the existing longest-prefix-first ordering has to keep holding.

### UX

The route list groups under a header showing the cookie domain and the required
permissions — "anyone holding `app.immich.*` can reach these 4 routes" is the sentence the
UI has to make obvious,
because it's the one people will get wrong. A route's row shows a lock badge; an ungrouped
route shows nothing, since that's today's behaviour and it stays the default.

A group requiring a permission nobody holds is a lockout, and with `app.*` being an open
namespace it's a lockout a typo can cause. Resolve the requirement against actual users at
save time and warn when the answer is zero.

### Questions

- Can one route group span two cookie domains? (Probably not — say so and validate.)
- What happens to a group's live sessions when its policy changes? Re-evaluated per request
  (option A in §3 gets this free) or only at next sign-in?
- Should `mode: "none"` groups exist at all, i.e. is a group useful purely as visual
  organisation, or is a group always an auth boundary?
- Does the gate belong on the whole route or on path prefixes within it? (Immich: `/api`
  needs different treatment from `/` — see §7. That may argue for per-path policy inside a
  group rather than per-route.)

---

## 5. Getting past the second login

After the gate, the app shows its own login. The user's instinct in the brief is right:
make it automatic rather than eliminate it.

**Option A — auto-continue the OIDC flow.** The app is configured for SSO against SC and
set to auto-launch (Immich has `oauth.autoLaunch`; many apps have an equivalent). The
browser bounces to `/oidc/authorize`, and because a live SC session already exists, SC
skips the "Continue as X?" screen and redirects straight back. Net effect: the app's login
page appears for zero frames. Needs a per-client `skipConsent` flag, or a general rule that
a client registered by the owner never prompts — arguably the confirm screen's only real
job is anti-phishing, which the gate has already handled.

**Option B — trusted identity headers.** `Remote-User` and friends, with the app configured
to trust them. Zero redirects, no second flow at all. Very few apps support it (Immich does
not), and any bypass path or renderer bug becomes full impersonation. Support it as a group
option for the apps that do; don't build the plan around it.

**Option C — accept the double login.** Two clicks, no work. Worth keeping as the honest
baseline against which A's complexity is measured.

**Leaning:** A, with B available per group.

### Questions

- Should `prompt=none` be implemented properly (spec-correct silent re-auth) rather than a
  bespoke skip flag? It's the standard answer and other RPs may already send it.
- If the gate and the app's SSO session have different lifetimes, users get randomly
  bounced. Should minting a gate session also refresh OIDC sessions, or vice versa?
- What is single-logout? Signing out of SC should plausibly close app sessions, but SC has
  no `end_session_endpoint` today and RPs each do it differently.

---

## 6. Closing the SSO gaps

"Finish up the SSO client stuff and test it" — what's actually missing, from the code:

- **No email claim, and no email field on users at all.** This is a hard blocker, not a
  polish item: Immich's OAuth defaults to scope `openid email profile` and keys accounts on
  `email`. `UserRecord` in [`auth.ts`](../apps/server/src/auth.ts) has no email. Needs a
  field, a UI, and `email`/`email_verified` in the ID token and userinfo. **Question:** is
  email required at account creation, or optional-but-required-before-SSO?
- **Claims ignore scope.** `groups` is emitted unconditionally; `profile` is advertised in
  discovery but adds nothing. Harmless today, wrong the moment a strict RP checks.
- **No refresh tokens.** A 1h access token with no refresh means the RP re-runs the whole
  flow hourly. Silent with §5's auto-continue; visible without it.
- **No `end_session_endpoint`** (see §5).
- **Single signing key, never rotated.** Fine now; a rotation story is cheap while there's
  one relying party and expensive later.
- **userinfo doesn't check `aud` or scope** — it accepts any token this server signed,
  including one minted for a different client.
- **Native-app redirect URIs** (`app.immich:///oauth-callback`) parse fine through `new URL()`,
  but nothing has confirmed the flow end to end.
- **Testing.** [`oidc.test.ts`](../apps/server/test/integration/oidc.test.ts) covers the
  store and token layer well and stops at the HTTP boundary. What's missing is a real RP
  against a real server — the `verify` skill and the e2e lab exist for exactly this.

---

## 7. Non-browser clients — the sharp edge

**This is the part that decides whether the plan survives contact with Immich.** The mobile
app talks to `/api` directly. It has no browser, no cookie jar, and will not follow a 302 to
a login page. Gate the API and the app breaks; exempt the API and the gate protects nothing,
because `/api` *is* the attack surface.

Options, roughly in order of preference:

**Option A — device tokens presented as a header.** SC issues a long-lived token bound to
(user, group, device name), revocable per device from the Users screen. The user pastes it
into the app's custom-header setting; the verifier accepts `Authorization: Bearer sc_…` or
`X-SC-Token` as an alternative to the cookie. Immich's mobile app exposes custom proxy
headers — **verify against the current release before committing to this.** Generalises to
any client that can set a header, which is most of them.

**Option B — HTTP Basic at the gate.** The device token as a password; the verifier accepts
`Authorization: Basic`. Covers DAV clients and anything that only knows about Basic. Careful
not to send `WWW-Authenticate` on browser requests, or browsers pop a native password box
instead of following the redirect.

**Option C — mTLS client certificates** on the API hostname. Strongest, and SC already runs
a CA for the node protocol ([`tls.ts`](../apps/server/src/tls.ts)), so the machinery exists.
Enrolling a phone is a much worse experience than pasting a token.

**Option D — path bypass, app's own auth only.** `/api/*` skips the gate. Honest about what
it gives up: for that path you are back to trusting Immich, which is the thing the feature
exists to avoid. Might still be the right call for a first cut, as long as it's a deliberate
per-group setting that says so in the UI rather than a quiet default.

### Full protection is a per-app setting, not a global mode

The conclusion this pushes back into §4: **how much of a route is gated is per-group
policy**, with three settings rather than a boolean —

- **Full** — every path, every client. Correct, and only usable for apps with no native
  client (or whose native client can set a header, option A).
- **Browser paths only** — the gate covers everything except a declared bypass set, which
  falls back to the app's own auth. What Immich needs today.
- **None** — today's behaviour, and the default for existing routes.

Building it this way is worth doing even where only the middle setting is currently usable.
App support for header-based and proxy-fronted auth is improving, and the difference between
"we have a full mode nobody can use yet" and "we'd have to redesign to add one" is the
difference between flipping a dropdown later and revisiting the route model. It also makes
the compromise legible: a group sitting on *browser paths only* is visibly a compromise in
the UI, with the bypassed prefixes listed, rather than a checkbox someone ticked once.

### Questions

- Do device tokens carry the user's full permission set, or a narrower one
  (`app.immich.*` only, so a stolen phone token doesn't also open the file browser)?
  Narrower is clearly right; the question is whether the UI makes it selectable or just
  scopes a token to the route group it was minted for.
- Are they visible/revocable per device in the Users screen? (They should be — this is the
  credential most likely to end up on a lost phone.)
- Does the same token work for the web session, or are they strictly separate credential
  types? Separate is safer and means two things to explain.
- Immich splits web and API onto separate hostnames in some deployments — is that the
  cleaner shape here (one fully-gated route, one device-token route, same group and so the
  same session)? That is what the brief's "api route on a separate subdomain reusing the
  cookie from the other item in the group" was reaching for, and it may be a better answer
  than path bypass: separate hostnames mean separate policy with no path-matching
  precedence to get wrong.

---

## 8. Ordering

Each step is independently useful, which matters because the whole chain is long.

1. **Permissions v1** (§1). Standalone, valuable without any of the rest, and unblocks the
   segregation goal on its own. Nothing here touches the proxy. The matcher and the
   `panel.*` registry come first; `app.*` is inert until step 4 gives it a consumer, so it
   can ship as storage-plus-claim before anything enforces it.
2. **Email on users + the SSO gaps** (§6). Also standalone: it makes Immich-via-SC-SSO
   work *today*, VPN or not, which is a real intermediate state worth shipping to.
3. **Gateway session + verifier** (§2, §3), with one hardcoded group, no UI.
4. **Route groups + renderer + UX** (§4).
5. **Auto-continue** (§5) and **device tokens** (§7) — in whichever order the first real
   Immich install demands, which will probably be device tokens, because a broken phone app
   is noticed immediately and a double login is merely irritating.

---

## 9. What this does not protect

Worth stating loudly, because "auth-gated" reads as stronger than it is:

**The gate only covers traffic through the proxy.** The app still publishes a port on its
host's LAN address ([`resolveNodeIp`](../apps/server/src/features/proxy/manager.ts)), and
anything that can reach `10.0.0.5:2283` bypasses Caddy entirely. Against the stated threat
model — the internet, plus a router that only forwards 80/443 — that's fine. It is not fine
against a compromised device on the LAN, and it will not stay fine as soon as a route
targets a host outside it.

The fix is already designed, in the deferral ladder of
[idea_reverse_proxy.md](idea_reverse_proxy.md) and in
[idea_node_overlay.md](idea_node_overlay.md): the `sc-proxy` docker network for same-node
routes (publish nothing at all), and the WireGuard overlay for cross-node. A gated route
whose port is still open to the LAN should probably say so in the UI — a warning badge on
the route row, not a paragraph in a doc nobody reads.

Also not covered: the app's own bugs *after* a legitimate user is through; a compromised
proxy node (it terminates TLS and sees everything); and anything about what the app does
with the identity headers once it has them.

## Consolidated open questions

The ones that most change the shape of the work, gathered from above:

1. How do wildcards and later-added nodes interact — snapshot at grant, `*` for owner
   only, or wildcard-excluded sensitive nodes? (§1)
2. Are `app.*` role names free text, or registered per OIDC client? (§1)
3. `Feature.opPermissions` composed at compile time, or a central table — and at what node
   granularity? (§1)
4. Per-host scoping: an extra path segment, a separate field, or fleet-wide in v1? (§1)
5. Parent-domain cookie per group, or host-only cookies with a ticket handshake? (§2)
6. Is the gate session the same record as the SC login session? (§2)
7. *(settled 2026-08-29 — SC answers subrequests as a PoC, `sc-auth` container later.)*
   What has to be true of the endpoint and the cookie format for that move to stay cheap?
   (§3)
8. How does Caddy address SC — `primaryUrl`, resolved node IP, or a new `internalUrl`? (§3)
9. Is email mandatory on accounts? (§6)
10. Device tokens, mTLS, an API path bypass, or a separate API hostname for the Immich
    mobile app — and does that answer change the route-group model? (§7)
