# Next items to implement

## Smaller items

- View agent config in the agents section

- base64 encoding of the blob to manually send it in the body is not ideal, can we support multipart somehow?

- Prefix API endpoints with /api/

- RBAC gap: only the Users/OIDC-client admin endpoints (`requireOwner` in `handler.ts`) have any
  permission check. Every other endpoint (servers, files, docker, systemd, network, tasks, config,
  install) runs for any authenticated user regardless of role — admin/operator/viewer are currently
  indistinguishable once logged in. See the `Role` doc comment in `shared/src/index.ts`. Don't forget
  to close this before leaning on roles for anything real.
  - Terminals are the exception now (2026-07-04): they run as the caller's mapped system user,
    deny-by-default for unmapped operator/viewer. Files/exec/docker/systemd still bypass this.
- System users, follow-ups to the 2026-07-04 slice (manual mapping + per-host Users tab):
  - Agent version skew: an outdated agent ignores `openShell.asUser` and opens a root shell.
    Consider a minimum-agent-version gate on impersonated shells.
  - Per-node mapping overrides (map keyed by machine id) once someone actually has divergent
    usernames per host; today one username applies fleet-wide.
  - Provisioning polish: per-host manual create + group editing exist now (mapped-hosts modal in
    Settings → Users); still pending are SC-allocated consistent UIDs across hosts, SSH
    authorized_keys management, delete users / change shell-home, audit log of who opened which
    terminal.
- Shortcut to sc logs

- [DONE] Delete-app modal, folder picker "empty" row, post-create navigation, Overview
  port links (2026-08-16) — `DeleteAppModal` now shows `HostName (id)` instead of a raw
  uuid and requires typing the app name before "Delete folder & remove app" enables (the
  "keep the folder" path stays a single click, since it's reversible via re-import).
  `DirectoryPicker`'s empty-directory row now reads "(empty directory)", italicized, so it
  doesn't look like a phantom file entry. `NewAppModal`/`ImportAppModal` already returned
  the new app's id — `AppsView` now opens it via `onOpenApp` instead of just reloading the
  list. Overview's services table now links published host ports (`http://<host-ip>:<port>`,
  parsed from `formatPorts()`'s `8080→80` shape) — falls back to plain text if the host's IP
  isn't known yet. The "port protocol" note otherwise looked already covered by the compose
  editor's existing tcp/udp host/container fields — flag a concrete example if something else
  was meant.

- Deploy reverse proxy, creates a temporary error thing? weird
- reverse proxy: add route path perfix, maybe have a checkbox to enable stripping the path prefix?
- reverse proxy: test routes, show a mark if they're valid or not (i.e if there's anything behind them), add this to the list of recurring things
- reverse proxy, more introspection to what lets encrypt certificates have been fetched, what has attempted to be fetched but failed, routes configured and on
- We can get this from the log but it's not ideal.

Figure out the linkage between reverse proxy and apps, should you create the link in the reverse proxy? in the app? should we use some new port descriptor to help this? how should it work?

- Additionally, do we need to expose the port on the local network?
  - I guess for multi node setups it would need a cluster wide overlay network, using wireguard or something like that, out of scope for now.

## Big tasks pending design, do not automatically implement these unless prompted specifically

### Module based system

Split server central up into modules each which provides rpc commands and events, tasks, roles, and so on.

The module keyword is probably reserved in js, typescript or whatever languages we may use in the future so find a new word for it as well (plugin?)

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

### App system

> [DONE] v1 implemented (2026-08-13), per [doc/idea_app_system.md](doc/idea_app_system.md) and the
> design handoff in `doc/apps feature design/` (Apps list = cards-grouped-by-server, App detail =
> tabbed Overview/Compose/Volumes/Controls/Logs matching the `ServerOverview` + sub-tabs pattern,
> create = single modal, import = stepped modal). An App is `{ id, name, hostId, dir, composeFile,
project, createdAt }` (`shared/src/index.ts`), backed by `AppStore` (`apps/server/src/apps.ts`,
> `.sc-data/app-registry.json`) and a new `docker_compose_action` task kind
> (`up`/`restart`/`stop`/`down`, optional `pullFirst`) that drives `docker compose -f <path> -p
<project> <verb>` directly off the App's directory — works even on a fully-down App, unlike the
> existing container-id-based `docker_stack_action`. Status/services come from `docker compose ps`
>
> - `config --format json` (`getAppStatus`/`composeConfig` in `apps/server/src/docker.ts`) rather
>   than a hand-rolled YAML parser or the fuller running/disk/reconcile merge
>   `doc/idea_stack_registry.md` §2 describes — good enough for the status badge + services table,
>   that fuller merge stays a future refinement. **Not yet built:** the streaming-exec primitive —
>   `up`/`pull` run over the plain 30s `exec()`, same known limitation `docker_image_pull` already
>   lives with (single end-of-command log line, fails outright past 30s on a slow pull). Swapping the
>   transport later needs no UI or task-kind rework, only the internals of `composeStackAction`.
>
> Naming note: this reclaimed the `App` type/name. It had briefly been the OIDC relying-party
> registration (`listApps`/`createApp`/`deleteApp`, Settings → Apps tab) as a placeholder ahead of
> this design, per the 2026-07-02 entry below — that's been renamed back to `OidcClient`
> (`listOidcClients`/`createOidcClient`/`deleteOidcClient`, Settings → "SSO Clients" tab) so the two
> unrelated entities don't collide.
>
> Deliberately still out of scope, per the v1 doc: reverse-proxy routes, app-provided OIDC/auth
> roles, per-section reconcilers, and the stack registry's discovery scan for compose files SC
> didn't create. Those depend on the Role-set redesign noted below and aren't blocking anything now.
>
> Concept from a 2026-07-02 discussion; architecture sketched 2026-07-13 (App = binding record in
> SC store referencing a compose stack + routes + provided roles + oidc section, per-section
> reconcilers; compose file stays source of truth for what runs — no SC-native service format).
> Full unification (routes + app-provided roles + reconcilers) still depends on the Role-set
> redesign below — `Role` is currently a single enum value per user (`shared/src/index.ts`), needs
> redesigning as a set of roles per user so app-provided roles (and things like a standalone
> "terminal access" role) can be assigned independently and additively, not just swapped for one
> value. Example of the eventual shape: Jellyfin would be an App with (a) a compose stack (maybe
> templated), (b) a routes object (TBD — reverse-proxy config), (c) auth roles the app provides
> (e.g. `jellyfin.user.adult`, `jellyfin.user.kid`, `jellyfin.admin`) assigned to Server Central
> users to grant app-scoped access — actual permission mapping still has to be configured inside
> the app itself, SC only hands it identity + role claims.

### Manual-install supervisor script

> Design spec: [docs/manual-install-supervisor.md](docs/manual-install-supervisor.md).
> Manual (custom) installs currently spawn the agent one-shot, so self-update's
> "exit and let the supervisor re-exec" leaves them dead. Plan: write a
> self-restarting `sc-agent-run.sh` into the install dir (Restart=always equivalent)
>
> - emit the agent pid to a file. Not yet implemented.

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

## Stack management

TODO

### Task system

> Design spec: [docs/task-system.md](docs/task-system.md). Seven kinds implemented:
> `find_wan_ip` (control-plane + per-node), `cmd`, `service_action`, `docker_stack_action`,
> `docker_container_action`, `docker_image_pull`, `update_agent`. Run history and a logs UI
> are implemented; schedules/cancel/resume are designed but still deferred there.

- [DONE] Corner widget + live task modal (2026-07-23): `TaskWidget` (bottom-right,
  app-root-mounted in `App.tsx`) shows in-flight (pending/running) runs with a short
  log tail, click-through to `TaskModal` — a live status+log view sourced from the same
  WS-driven `useConnection()` state, opened via a new `taskModalManager` singleton
  (`apps/web/src/taskModal.ts`, mirrors `connectionManager`'s shape) so it can be triggered
  from anywhere without prop-drilling. `runTaskAndWait` gained an opt-in `autoOpenModal`
  flag (used by `update_agent` and `docker_image_pull` only — quick actions like
  service/container start-stop keep their existing inline busy-state instead of popping a
  modal every click). `TasksView` rows for running/pending tasks now open the modal instead
  of the old static inline-expand (finished rows keep the inline expand). Shared formatting
  (`specSummary`/`resultSummary`/etc.) extracted to `apps/web/src/taskFormat.ts` so the
  widget/modal/TasksView don't duplicate the exhaustive per-kind switches.
  Not verified in a real browser (no Playwright in this dev container) — typecheck + vite
  build are clean and the server-side task flow was verified end-to-end over the HTTP API,
  but the widget/modal haven't been visually confirmed.
  - Follow-up same day: found (via a real usage report) that task log lines were arriving
    doubled — root cause was a pre-existing bug in `connection.ts`, not this feature: React
    StrictMode's dev-only double mount of the connection effect raced `stop()`'s `ws.close()`
    (not instant) against `start()`'s new socket, leaving both registered server-side for a
    moment. Fixed by stripping the old socket's handlers in `stop()` and guarding every handler
    with `this.ws === ws`. Also added a `tone` prop to `Modal` (`ui.tsx`) + `modalTone()`
    (`taskFormat.ts`) so the task modal's header is blue+spinner while running, green/red/gray
    once it lands, using a new reusable `.spinner` CSS class shared with the widget's pill.

Candidate task kinds, surveyed against `handler.ts` 2026-07-22 (test from the design
doc: would you want history of it, a last-result for it, or to schedule it? if not,
it stays plain RPC):

- [DONE] Stun IP check (`find_wan_ip`, control-plane + per-node target)
- [DONE] Start/stop/restart/enable/disable services (`service_action`, 2026-07-22) —
  replaced `handleSystemdServiceAction`; `ServicesView` now calls `runTaskAndWait`.
- [DONE] Docker stack action (`docker_stack_action`, 2026-07-22 — start/stop/restart/down)
  — replaced `handleDockerStackAction`; `DockerStacks` now calls `runTaskAndWait`.
- [DONE] Docker container action (`docker_container_action`, 2026-07-22 —
  start/stop/restart/pause/unpause/remove) — replaced `handleDockerContainerAction`;
  `DockerContainers` now calls `runTaskAndWait`.
- [DONE] Docker image pull (`docker_image_pull`, 2026-07-22) — replaced
  `handleDockerImagePull`; `DockerImages` now calls `runTaskAndWait`, still shows
  `{ ok, message }` (a failed pull is a normal result, not a thrown error).
- [DONE] Agent updates (`update_agent`, 2026-07-23) — replaced `handleUpdateNodeService`;
  `AgentsView` now calls `runTaskAndWait`. Initially landed as "completes on ack" (the run
  resolves the moment the agent acknowledges, before its own WS drops for the binary swap) —
  didn't seem to need §8.5 resume-across-reconnect for that scope. Revised same day: the run
  now stays `running` until the fleet actually sees the agent reconnect as a _new_ connection
  on the target version (`waitForAgentReconnect`, `apps/server/src/tasks/types.ts`), polling
  every 2s up to a 5-minute timeout. Still didn't need §8.5 — the control plane process itself
  never restarts here, only the remote agent's connection drops, so the run's own promise just
  keeps waiting in place; §8.5 remains relevant for anything where the _control plane_ restarts
  mid-run (control-plane self-update, below). Covered by
  `apps/server/test/integration/update-agent-task.test.ts` (real Fleet/HostAgent, no sockets).
  - Follow-up same day, from a real dev-workflow report: a reconnect on the _wrong_ version (the
    control plane's own `AGENT_VERSION` had drifted from what the freshly-built agent binary
    actually reports) made the run hang for the full 5-minute timeout instead of failing clearly.
    Fixed: a new, online connection for the machine is now treated as the definitive answer — if
    its version doesn't match (and not `force`), the run fails immediately with "Agent reconnected
    on X, expected Y" rather than continuing to poll for a version that was never going to change.
  - Investigating _that_ led to a much bigger find: running the test suite while a real `bun run
dev` instance is up (developing against your own home lab) could silently corrupt the real
    instance's `.sc-data/agents.json` — see the "Test suite could silently corrupt..." entry under
    Fixed in changelog.md for the mechanism and fix (`apps/server/test/env-preload.ts` +
    `apps/server/bunfig.toml`). Per explicit instruction, the already-corrupted real
    `apps/server/.sc-data/agents.json` (a stray phantom `machine-abc`/`host-installed` entry
    alongside the real nodes) was left alone — not cleaned up, since it's self-healing as real
    agents reconnect and the user preferred to handle it themselves.
- Agent install (`handleInstallNodeService`) — multi-step (write binary+cert,
  install unit, hand off); a task would give visible progress + a durable
  "did it actually finish" record instead of just a `startCommand`.
- Control-plane self-update (`handleUpdateControlPlane`) — same shape as agent
  update (kills its own process mid-run), same resume-across-reconnect problem,
  on the control-plane side instead.
- Proxy apply (`handleApplyProxyConfig` / `handleDeployProxy`) — already returns
  a `ProxyApplyResult`; wrapping as a task gives apply _history_ instead of only
  ever seeing the latest result.
- Backups of various kinds — not implemented at all yet (no code exists); would
  be a new task kind built from scratch.

Considered and set aside: user/system-user management (`createUser`,
`setUserSystemUser`, `revokeUserSession`, …) wants an _audit log_, not
run-history-with-last-result — different shape, likely a separate feature.
`handleProbeInstallPath`, `handleSystemUserHostStatus`,
`handleGetControlPlaneStatus`, `handleDockerVolumeRemove` are reads/probes or
instantaneous+unambiguous — the doc explicitly excludes plain reads ("you don't
schedule a directory listing").

The task system could have task scoped logs, time tracking, status updates etc

Further down the road (not for v1) we could have long running tasks that might need things such as progress tracking for resuming and such, but yeah.

**Scheduled tasks**

A sub feature would be scheduled tasks which runs at an interval. Unsure about the naming, the goal would be: On the interval, trigger, or whatever: create a task instance.

So maybe this could be a flows thing? with various triggers?

### Better process list?

But at some point maybe it's better to just jump into htop in the terminal?

# Already implemented, archive

- [DONE] Agent reconnect hardening (2026-07-24) — connect deadline, sticky control URL, heartbeat
  - `connect()` had no timeout of any kind: a black-holed endpoint cost ~127s of TCP SYN retries
    before trying the alt URL, and a peer that accepted the socket but never acknowledged wedged the
    loop forever. Now a 10s per-attempt deadline (`CONNECT_TIMEOUT_MS`).
  - The URL that last worked is persisted in a new `state.json` (install data dir, or
    `SC_AGENT_DIR`/`~/.sc-agent` for a live agent) and tried first, with a re-probe of the configured
    order every 10th reconnect cycle. Kept out of `config.json` on purpose — that's installer-written
    input, rewritten wholesale by `installSelf`.
  - Heartbeat: control plane pings every 15s (capability-gated, one beat immediately on connect),
    agent pongs and runs a 45s watchdog that terminates the socket and reconnects. Closes the
    half-open-TCP hole where an agent wrote metrics into a void indefinitely. Node server WS
    `idleTimeout` pinned to 60s so the control plane's own view of a dead connection self-heals faster.
  - Covered by `apps/server/test/integration/agent-reconnect.test.ts` (real agent subprocess against
    a real NodeServer: hung-primary fallthrough + sticky persistence, capability-gated pinging, and
    watchdog-driven reconnect against a fake control plane that goes silent). Not yet observed on a
    real flaky link — the half-open case is simulated, not reproduced against real NAT eviction.

- [DONE] Force reinstall option for a broken agent install (2026-07-23)
  - `installNodeService` / the `installService` node-protocol message gained an optional `force`
    flag, threaded through `handler.ts` → `HostAgent.installService` → `Agent`'s `onInstallService`
    → `installSelf` (`agent-cli.ts`). When set, it bypasses the `isInstalled()` "already installed"
    refusal and overwrites the existing cert/config/binaries; for the systemd mechanism it also
    explicitly `systemctl restart`s afterward, since `enable --now` is a no-op on an already-active
    unit and wouldn't otherwise pick up the overwritten binary.
  - `SetupWizard` shows a "Force reinstall" checkbox once an "already installed" error comes back,
    letting the operator retry with `force: true` to repair a broken/partial prior install.

- [DONE] Per-node STUN, terminal padding, ctrl-w word-delete (2026-07-22)
  - Network view has a "Check STUN" button per server, running `find_wan_ip` targeted at that host
    (new `stunRequest`/`stunResponse` node-protocol messages, `stun` agent capability,
    `HostAgent.discoverStun()`) alongside the existing control-plane-only STUN check and the
    WS-observed `remoteIp`.
  - Terminal: fixed the slightly-clipped last line (padding moved from `.terminal-host` onto
    `.xterm` so FitAddon's row math and the visual inset agree; refit again once the monospace font
    loads). Ctrl+Backspace now does word-delete (`\x17`) as a working alternative to Ctrl+W, which
    browsers reserve for closing the tab and won't let a page intercept.

- [DONE] Version-based changelog (2026-07-22)
  - `changelog.md` restructured from flat dated entries into `## Unreleased` / `## [x.y.z] - date` /
    `## Pre-0.8` sections (existing dated entries nested underneath, unchanged content — no
    backfill of which pre-0.8 entry shipped in which of the 3 existing tags, not worth the
    ambiguity). `scripts/create-release.ts` now has `cutChangelog()`: on release it renames
    `## Unreleased` to `## [<version>] - <date>` and reopens an empty `## Unreleased` above it,
    committed alongside the version bump. New entries just get written under Unreleased as they land.

- [DONE] Docker rework — Portainer-lite (2026-06-22)
  - Docker tab is now a nested sub-tabbed view (Overview · Stacks · Containers · Volumes · Images), routed as `#/server/<id>/docker/<section>` (`routes.ts` `DockerSection` + volume-browser drill-down). Shell + sections live in `apps/web/src/components/docker/`.
  - Backend (`apps/server/src/docker.ts`): added `dockerOverview` (counts + `docker system df`), `dockerStacks`/`dockerStackAction` (compose-project labels, no compose binary), `dockerContainerInspect`, `dockerVolumeInspect`/`dockerVolumeRemove`, `dockerImageAction`/`dockerImagePull`; `dockerContainerAction` gained pause/unpause. `ContainerInfo` now carries derived `project`/`service`.
  - Reusable log viewer (`components/LogViewer.tsx` + `ansi.ts`): custom ANSI-to-HTML rendering with find-in-text (highlight, prev/next, match counter) and wrap toggle. Volume file browser reuses `FilesView` rooted at the volume mountpoint.
  - Still pending (future): log pagination/streaming (currently tail 2000); reusing LogViewer for systemd/journald logs; per-stack compose up/pull via the compose plugin.

- [DONE] Networking host menu (2026-06-22)
  - New per-server "Network" tab: `getNetworkInfo` (`apps/server/src/network.ts`) lists adapters, addresses, and routes via iproute2 JSON (`ip -j addr` / `ip -j route`), parsed into `NetworkInterface`/`NetworkAddress`/`NetworkRoute`. Unavailable-state fallback when `ip -j` isn't present.
  - Remote IP detection of agents: control plane records each agent's WS source IP (public IP across NAT) via `server.requestIP(req)` at upgrade, carried on `HostAgent.remoteIp` + `ServerStatus.remoteIp`, surfaced in the Network view. Null for the embedded host.
  - Still pending (food for thought): grouping hosts by subnet.

- [DONE] Systemd host menu (2026-06-22)
  - New per-server "Services" tab: `systemd.ts` provides `systemdList` (merges `list-units` runtime state with `list-unit-files` enabled state), `systemdServiceAction` (start/stop/restart/enable/disable, unit name validated), `systemdServiceLogs` (`journalctl`), and `systemdUnitFile` (`systemctl cat`). View has a filter, active-only toggle, controls, and logs/unit-file modals.

- [DONE] Smaller items batch (2026-06-21)
  - Embedded agent now reports `mode: "embedded"` (distinct from live/installed) and outranks both in the fleet (`MODE_RANK.embedded = 3`); `installNodeService` rejects it with a clear message.
  - Add Node dialog auto-detects the freshly-enrolled live agent (watches the `servers` list against a baseline captured on open) and shows a "Continue setup" banner that hands off to the `SetupWizard` inline — no need to visit the Agents view.
  - Delete servers: `deleteServer` op + `Fleet.remove()` (offline-only; connected/embedded rejected). Agents view has a Delete action on offline rows.
  - File browser previews images inline: agent base64-encodes recognized image types (≤16 MB) and `FileContent` carries `encoding`/`mimeType`; `FilesView` renders `<img>` instead of the binary placeholder.
  - `AGENT_VERSION` is read from `shared/package.json` `version` instead of a hardcoded string.

- [DONE] Slight node refactor — merge node into server, collapse the agent classes
  - `apps/node` is gone; the agent now lives in the server and runs via `sc-server --agent --control … --token … --cert …`. The same single binary is both the control plane (no args) and the host agent (`--agent`); `apps/server/src/index.ts` dispatches on `--agent` before booting the control plane.
  - Source moved into `apps/server/src/`: `agent.ts` (the host-side `Agent` runner, transport-abstracted), `machine-id.ts`, and `agent-cli.ts` (the `--agent` connect/reconnect loop, `WsTransport`, self-install).
  - The confusing trio collapsed to two clear types: `Agent` (runs on the host) and `HostAgent` (the control plane's handle to any host — formerly `NodeProxy`, now also replacing the `HostAgent` interface). `LocalAgent` is deleted; the embedded host is just `createEmbeddedAgent()` (`embedded-agent.ts`) — a `HostAgent` whose transport feeds an in-process `Agent`. No more per-method forwarding.
  - Build retargeted: `bun run build:agent` compiles the server entry into `dist/sc-agent-{linux,mac,windows}-x64` (arch-suffixed for future arm64); the install command + systemd `ExecStart` invoke the binary with `--agent`.
  - Verified: typecheck clean, all 16 server tests pass (the integration test spawns the real `--agent` subprocess), and both `--agent` and plain control-plane boot work.

- [DONE] Web: Store state in url, e.g the current folder were viewing, the current file were editing, the current open view etc
  - Example: /server/fm/folder/path/here
  - Hash-based routing (`apps/web/src/routes.ts` routeToHash/hashToRoute + `hooks/useHashRoute.ts`). The route carries view/server/tab and, for the files tab, the folder path + open file (`#/server/<id>/files/<path>?f=<file>`). FilesView is now controlled by the route. Replaced the old localStorage route.

- [DONE] Add server wizard / self-install flow
  - Live agent connects & verifies as today. The Agents view shows an "Install as service" action for online live agents → `installNodeService` → control plane mints a durable per-machine token and sends `installService` to the live agent.
  - The agent writes the binary+cert to stable paths, installs+enables a systemd unit (`connect --mode installed` with the durable token), errors if a unit already exists, then exits so the installed service takes over (fleet demotes the live connection).
  - Durable tokens: enrollment tokens expire (30m), so installed agents authenticate with a non-expiring per-machine token persisted in `.sc-data/agent-tokens.json` (`NodeServer.mintAgentToken`, accepted by `validateToken`).
  - The pasted install command runs the agent with `sudo` (it manages the host and installs a root systemd service). Windows command unchanged (self-install is Linux-only).
  - Verified end-to-end on a real systemd box (compiled binary, sudo): live → install → unit active → installed agent takes over → live exits 0.
  - Still pending: a true "pending" node state in the UI before first connect; interactive setup; non-systemd platforms (mac launchd / windows).

- [DONE] Machine ids
  - Multiple agents running on the same machine, or just reconnecting for that matter creates a new instance, we need a stable machine id of sorts
  - Additionally the self install flow would also create 2 entries, but the systemd one should take priority and the connection to the second one should be regarded as a "dummy" one.
  - Agent resolves a stable machine id (`apps/node/src/machine-id.ts`: hashed /etc/machine-id, else a persisted UUID) and sends it in `identify`. Fleet keys on it, so reconnects/duplicates collapse to one entry.

- [DONE] Agent states (live/installed)
  - States:
    - Live; pasting the command, a live connection but not permanently installed agent
    - Installed; the installed agent as a systemd service (or whatever else in the future), takes priority over live.
  - Agent sends `mode` (`--mode live|installed`, default live) in `identify`. Fleet picks the highest-priority connection per machine as active (installed > live); the loser is demoted to a standby/dummy (metrics suppressed, not served). `acknowledged` now carries `active` so an agent knows if it's the standby.

- [DONE] sc-tls in sc-data
  - TLS bundle now lives under `.sc-data/tls` (`ensureTls(path.join(CONFIG_DIR, "tls"))`); dropped the separate `.sc-tls` gitignore entry. Old certs in `.sc-tls` are abandoned (regenerated fresh in the new location).
