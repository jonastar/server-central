# Next items to implement

Open work only. Anything shipped is recorded in [changelog.md](changelog.md) — don't
re-document finished work here, and delete an item from this file once it lands.

## Smaller items

- View agent config in the agents section
- Prefix API endpoints with `/api/`
- Shortcut to `sc` logs
- base64-encoding the blob to send it manually in the body is not ideal — can we support
  multipart somehow?
- Features could expose overview data that contributes to the overview page
- Better process list? Or is it better to just jump into `htop` in the terminal at that point?
- Host user authorized keys mangement
  - Option to sync authorized keys across all mapped users?

### RBAC gap

Only the Users/OIDC-client admin endpoints (`requireOwner` in `handler.ts`) have any permission
check. Every other endpoint (servers, files, docker, systemd, network, tasks, config, install)
runs for any authenticated user regardless of role — admin/operator/viewer are currently
indistinguishable once logged in. See the `Role` doc comment in `shared/src/index.ts`. Close
this before leaning on roles for anything real.

Terminals are the exception (2026-07-04): they run as the caller's mapped system user,
deny-by-default for unmapped operator/viewer. Files/exec/docker/systemd still bypass this.

### System users

Follow-ups to the 2026-07-04 slice (manual mapping + per-host Users tab):

- Agent version skew: an outdated agent ignores `openShell.asUser` and opens a root shell.
  Consider a minimum-agent-version gate on impersonated shells.
- Per-node mapping overrides (map keyed by machine id) once someone actually has divergent
  usernames per host; today one username applies fleet-wide.
- Provisioning polish: per-host manual create + group editing exist now (mapped-hosts modal in
  Settings → Users); still pending are SC-allocated consistent UIDs across hosts, SSH
  `authorized_keys` management, delete users / change shell-home, and an audit log of who
  opened which terminal.

### Reverse proxy

- Deploying the reverse proxy creates a temporary error thing? Weird.
- Add a route path prefix, maybe with a checkbox to enable stripping the prefix.
- Test routes: show a mark for whether they're valid (i.e. whether anything is actually behind
  them), and add this to the list of recurring things.
- More introspection into Let's Encrypt: which certificates were fetched, which were attempted
  and failed, which routes are configured and on. This is available in the log today, but that
  isn't good enough.

Open question — the linkage between reverse proxy and apps. Do you create the link in the
proxy, or in the app? Should there be a new port descriptor to help this? How should it work?

- Related: do we need to expose the port on the local network too? For multi-node setups that
  would need a cluster-wide overlay network (WireGuard or similar) — out of scope for now.

## Task system

> Design spec: [docs/task-system.md](docs/task-system.md). Seven kinds implemented:
> `find_wan_ip` (control-plane + per-node), `cmd`, `service_action`, `docker_stack_action`,
> `docker_container_action`, `docker_image_pull`, `update_agent`. Run history, the logs UI, and
> the corner widget + live task modal are implemented; schedules/cancel/resume are designed but
> still deferred there.

Remaining candidate task kinds, surveyed against `handler.ts` 2026-07-22 (test from the design
doc: would you want history of it, a last-result for it, or to schedule it? if not, it stays
plain RPC):

- Agent install (`handleInstallNodeService`) — multi-step (write binary+cert, install unit,
  hand off); a task would give visible progress + a durable "did it actually finish" record
  instead of just a `startCommand`.
- Control-plane self-update (`handleUpdateControlPlane`) — same shape as the agent update (kills
  its own process mid-run), on the control-plane side instead. This is the case that actually
  needs §8.5 resume-across-reconnect: `update_agent` didn't, because only the remote agent's
  connection drops there, never the control plane's own process.
- Proxy apply (`handleApplyProxyConfig` / `handleDeployProxy`) — already returns a
  `ProxyApplyResult`; wrapping it as a task gives apply _history_ instead of only ever seeing
  the latest result.
- Backups of various kinds — not implemented at all yet (no code exists); would be a new task
  kind built from scratch.

Considered and set aside: user/system-user management (`createUser`, `setUserSystemUser`,
`revokeUserSession`, …) wants an _audit log_, not run-history-with-last-result — different
shape, likely a separate feature. `handleProbeInstallPath`, `handleSystemUserHostStatus`,
`handleGetControlPlaneStatus`, `handleDockerVolumeRemove` are reads/probes or
instantaneous+unambiguous — the doc explicitly excludes plain reads ("you don't schedule a
directory listing").

Wanted beyond that: task-scoped logs, time tracking, status updates. Further down the road (not
for v1), long-running tasks that need progress tracking for resuming.

**Scheduled tasks** — a sub-feature that runs tasks on an interval. Unsure about the naming; the
goal is: on the interval/trigger/whatever, create a task instance. Maybe this becomes a flows
thing, with various triggers?

## Big tasks pending design, do not automatically implement these unless prompted specifically

### Module based system

Split Server Central up into modules, each providing rpc commands and events, tasks, roles, and
so on.

`module` is probably reserved in JS/TypeScript (or in whatever languages we may use in the
future), so find a new word for it as well (plugin?).

### Reverse proxy — v1 shipped 2026-07-13, follow-ups pending

> Design + deferral ladder: [doc/idea_reverse_proxy.md](doc/idea_reverse_proxy.md). v1 is
> implemented (`apps/server/src/proxy/`, Proxy view in the web app): SC-deployed Caddy on one
> designated node, routes = host → `{node, published host port}`, LAN-IP upstreams uniformly.
> Still deferred, in order: sc-proxy shared docker network (same-node, no published ports),
> DOCKER-USER source restriction for gated cross-node routes, WireGuard mesh between agents
> (endgame — stable IPs, ports bound to wg interface only; decided against tunneling app traffic
> through SC), forward_auth role gating (needs the Role-set redesign), per-route reachability
> probes (the `httpRequest` agent primitive for them exists), DNS-01/wildcard certs.
> Not runtime-verified against a real dockerd yet: the deploy/apply path was exercised end to end
> in a netns (honest failures), but an actual Caddy bring-up + /load on a docker host is pending.

### App system — the layer above compose stacks

**Status (2026-08-21): the v1 "App" was renamed to what it always was — a compose stack — and
folded into the host's Docker tab (see changelog). `App` is now free for the layer above, which
is designed here but not built.**

Still missing on the compose-stack side, unchanged by the rename: the streaming-exec primitive
(`up`/`pull` run over the plain 30s `exec()`, the same limitation `docker_image_pull` lives
with), and the running/disk/reconcile status merge from `doc/idea_stack_registry.md` §2. The
fleet-wide "every stack on every host" list was deliberately given up — a stack is host-scoped,
and that view belongs to Apps.

Design settled in discussion 2026-08-21. An **App** is fleet-scoped and has no runtime of its
own; compose stacks are host-scoped and are what actually runs. An App owns/links: one or more
stacks, an optional OIDC client, proxy routes, backup policy, and (later) app-provided roles.
Decisions worth not relitigating:

- **Sub-resources keep their own stores and gain an optional `appId`** — never embedded in
  the App record. An OIDC client is usually something SC doesn't run; a stack usually has no
  login. Both must stay valid standalone. Deletion semantics differ per section and should be
  decided explicitly: OIDC client survives app deletion (its secret is deployed inside the
  app), backup policy dies with it, a route survives but warns.
- **App drops `hostId`.** That's the actual modeling win: a stack is one machine by nature,
  an App's identity/routes/roles are not. Today's `ComposeStack.hostId` stays where it is.
- **Creating a stack through SC should create its App 1:1, silently**, with "adopt" on
  unregistered ones. If the App layer is opt-in, it stays empty and backups/SSO never get
  configured — which was the point.
- **Config tracking is observation-based, not authorship-based.** No GitOps: the host stays
  source of truth, nothing reconciles or reverts, hand-editing on a live host stays
  legitimate. SC hashes the tracked files and appends a version whenever the hash moves,
  regardless of who moved it — UI edits get attributed, out-of-band edits get recorded as
  "changed on host". Authorship-based tracking would miss exactly the changes that matter.
  `listDir` already returns `modifiedAt`/`sizeBytes`, so the poll is cheap and needs no new
  agent primitive. The tracked set is hand-picked per app (not all of `volumes/`), and is
  probably the same picker as the backup one.
- **Backup is hand-picked volumes + a policy each**, not the five-way classification in
  `doc/idea_backup_secrets.md`. Keep exactly one bit of that taxonomy: _can this be copied
  hot, or does it need the container stopped / a dump_ — hot-copying a live postgres dir
  yields a backup that restores corrupt. Policy lives on the App; per-volume classification
  stays on the stack, and a policy referencing a volume that no longer exists must surface
  loudly, never silently drop out of the backup set.
- **Templates are the best justification for the App layer**, and mostly don't need the role
  work: a template carries a compose stack, port classification (which port is the HTTP UI →
  one-click proxy route), a settings schema, and an OIDC/roles section that can sit inert
  until roles land. Port classification is the cheapest high-value piece; proxy v1 already
  exists to consume it.
- **Template settings render once, at install. Never re-render.** A re-rendering template is
  a reconciler, and that's the drift problem again at smaller scale. Structural choices
  (services, volumes, networks) are frozen after scaffolding; scalar knobs (ports,
  passwords, limits, flags) live in `.env`, which compose interpolates natively and which
  has no merge problem — so those stay editable in the UI forever. No template _updates_ in
  v1; install is a one-way scaffold.
- **Template distribution starts narrow**: local files and a pasted git URL, not a
  browsable registry. A template is arbitrary compose on a host — closer to `curl | sh` than
  to installing a package.

Sequencing note: templates deliver value without the Role-set redesign, so the App layer isn't
blocked on it. The redesign is still the keystone for app-provided roles, proxy `forward_auth`
gating, and the RBAC gap above — and that gap matters most, because the UI currently offers
admin/operator/viewer while the server enforces almost none of it.

### Terminal session persistence / tmux session manager

> Prompted by real usage feedback (2026-08-17): the web terminal (`TerminalView.tsx`) is a bare
> host-shell PTY, ephemeral and tied 1:1 to the WebSocket connection
> (`AgentConnection.openShell()`, `host-agent.ts`) — navigating away or losing the tab kills it
> instantly, with no persistence underneath to reattach to. The confirm-before-leaving guard
> that shipped same-day is a band-aid, not a fix: the actual ask is persistent, named sessions
> you can walk away from and come back to.
>
> Real fix: back the terminal with **tmux sessions on the host** instead of a raw shell:
>
> - New agent-side primitives: list tmux sessions (name, created time, attached clients), create
>   a named session, kill a session, capture recent pane output (`tmux capture-pane`) for a
>   preview without attaching.
> - `openShell` (or a new `openTmuxSession`) attaches to a chosen session (`tmux attach -t
<name>`) instead of spawning a bare shell — the PTY dies with the WS same as today, but the
>   tmux session underneath survives, so reattaching later resumes exactly where you left off.
> - New UI: a session-card list (name, recent-output preview, "attach"/"kill"/rename) ahead of
>   the terminal view itself, replacing the current "Terminal" tab's straight-into-a-shell
>   behavior. The card list becomes the new tab landing; clicking a card opens the existing
>   `TerminalView` attached to that session.
> - Naming/lifecycle: who creates the first session for a host (auto-create "main" on first
>   visit vs. explicit create-only)? Do idle sessions ever get reaped, or live until manually
>   killed? Needs a decision before implementing.
> - Depends on tmux being present on the target host — same "not present" fallback question as
>   other host-tool-dependent features (`ip -j`, compose plugin, …); probably fall back to the
>   current bare-shell behavior with a note if `tmux` isn't found.

### Manual-install supervisor script

> Design spec: [docs/manual-install-supervisor.md](docs/manual-install-supervisor.md).
> Manual (custom) installs currently spawn the agent one-shot, so self-update's "exit and let
> the supervisor re-exec" leaves them dead. Plan: write a self-restarting `sc-agent-run.sh` into
> the install dir (Restart=always equivalent) and emit the agent pid to a file. Not yet
> implemented.

### Backup, config tracking & secrets

> Design spec: [doc/idea_backup_secrets.md](doc/idea_backup_secrets.md) (2026-07-25).
> SC as the abstraction layer above the OS: every stack, every piece of app config, and
> SC's own state declared in SC and backed up to a central repo, so an OS reinstall is
> recoverable. Core model — classify by _who writes it_, not by which layer it belongs to.
> Per-volume classification (`declared` / `captured` / `regenerable` / `external`, with
> unclassified as a **blocking** state so backups never silently lie), plus a `tracked`
> class for individual files SC observes but doesn't own (the `postgresql.conf`-inside-PGDATA
> case). Four destinations: plaintext git repo, an encrypted secret blob with **bounded**
> retention (deliberately _not_ in git — history can't be un-published on GitHub, and
> retained ciphertext makes rotation meaningless), an encrypted restic archive store for
> app-written volumes, and nothing. Compose files never contain secrets, only `${sc:...}`
> references materialized at deploy. Drift detection is the actual deliverable — being in
> git is worthless if nothing compares.
> Depends on the stack registry (per-volume metadata hangs off `StackRoot`). Open question
> flagged there: SC-as-repo-writer (leaning) vs full GitOps reconcile.
