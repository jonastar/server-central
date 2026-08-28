# Changelog

All notable changes to Server Central are recorded here. Grouped by release version,
newest first. There are Keep-a-Changelog sections (Added / Changed / Removed / Fixed)
nested under each. `bun run release` renames `## Unreleased` to the cut version and
opens a fresh `## Unreleased` above it.

**Keep entries short.** One line, roughly 20 words / 150 characters: what changed, and why a
reader would care. Reasoning, mechanism and caveats belong in the code comment, the doc, or the
commit message — not here. Prefer several small bullets over one long one. A genuinely large
feature may run longer; most don't earn it.

## Unreleased

### Added

- **Reverse proxy support.** The web UI works behind a TLS-terminating proxy; API calls and
  websockets are same-origin and relative. [docs/reverse-proxy.md](docs/reverse-proxy.md)
- **`bindHost`** (`SC_BIND`) sets the web listener's address, to keep the plaintext port on
  loopback behind a proxy.
- **`trustedProxies`** (`SC_TRUSTED_PROXIES`) honours a forwarded client address from listed
  proxies, so the login throttle and sessions see real client IPs.
- **`forwardedHeader`** (`SC_FORWARDED_HEADER`) picks which header that is — `X-Real-IP`,
  `CF-Connecting-IP`, RFC 7239 `Forwarded`. Defaults to `X-Forwarded-For`.
- **Trusted proxies are editable in Settings**, each entry optionally naming the header that
  proxy writes, for a server reachable through two front ends at once.
- **`allowedOrigins`** (`SC_ALLOWED_ORIGINS`) narrows CORS from `*`; the primary URL's origin is
  allowed automatically. Unset keeps today's behaviour. Editable in Settings, add/remove per entry.
- **Primary URL** replaces the OIDC issuer field as one canonical public URL for SC, reused as the
  `iss` claim. Changing it with SSO clients registered needs confirming.
- **Streaming exec.** `docker pull` and compose actions stream their output into the task log
  a line at a time, instead of one lump at the end.
- **Settings → Debug** runs a fake task that logs for a few seconds, for exercising the task
  widget and modal without a real slow action.
- **Every task action now shows its progress** where you clicked — a spinner and label that
  opens the run's live output — plus a card under the new Tasks button.
- **Tasks button in a new top bar**, with a live count and a panel of recent runs, so a finished
  task is still reachable without going to the Tasks view.

### Changed

- **API moved under `/api/`.** Ops are `POST /api/<op>`; websockets are `/api/events` and
  `/api/terminal`. OIDC routes unchanged. An open tab needs a reload.
- **Dev websockets skip the Vite proxy**, which can't forward upgrades under Bun. Release
  builds are served from one origin and unaffected.
- **Slow host commands no longer fail at 30s.** A streaming exec times out on silence, not on
  total duration, so a pull that keeps reporting progress can take as long as it needs.
- **Waiting on a task rides the events socket** rather than polling `getTask` every 400ms —
  the run's status was already being broadcast to the page.
- **External domain** renamed "External domain for agents" — it's the address agents dial on
  `:4142`, which differs from the UI's hostname when the proxy is a separate machine.

### Fixed

- **Browser Back now steps back up the folder trail in embedded file browsers** — a compose
  stack's Files tab and a container's Volumes tab, whose folder isn't in the URL. They push a
  history entry per navigation instead.

## [0.11.0] - 2026-08-25

### Added

- **Device passthrough in the compose editor.** Services now have a **Devices** field
  (compose's `devices:`), with a picker fed by a scan of the host's own `/dev` — USB serial
  adapters, GPU render nodes, V4L capture devices and `/dev/net/tun`, via the new
  `listHostDevices` op. A serial adapter is offered under its `/dev/serial/by-id/…` name with
  the product string read out of it ("dresden elektronik … ConBee II DE2667394") and the
  `/dev/ttyACM0` it currently resolves to shown underneath: the stable path is the one that
  belongs in a compose file, and it's exactly the one nobody can type from memory. Devices
  already mapped are marked as such under any of their names, so the same hardware can't be
  added twice through a symlink and its node. Short and long compose syntax both round-trip;
  anything the editor can't decompose stays untouched for the YAML tab. Zigbee/Z-Wave sticks
  and hardware transcoding were the two things a stack couldn't express here before —
  Home Assistant with a ConBee II now comes up from the visual editor alone.

- **Pull without deploying.** A compose stack's toolbar (and each service's action menu) has
  a plain **Pull** next to **Pull & up**: `docker compose pull` on its own, so images are
  fetched while the running containers stay exactly as they are until the next `up`. Same
  task kind as before — `docker_compose_action` gained a `"pull"` action — so it lands in run
  history with its output, like every other compose verb (and inherits the same 30s
  non-streaming `exec()` limitation a slow pull already had).

- **New compose stack from pasted YAML.** The new-stack modal's **Paste YAML** choice is
  wired: the pasted document is written as the stack's `compose.yaml` instead of the bare
  `services:` scaffold. It isn't validated before creation — `docker compose config` needs
  the file on the host — but the stack view opens straight onto it and validates there, so a
  nearly-right paste lands somewhere it can be fixed. **From template…** is still disabled;
  it waits on a template catalogue, not on this modal.

- **"Pull image to show suggestions" in the compose visual editor.** The suggested
  ports/volumes/environment pickers read the image's own `EXPOSE`/`VOLUME`/`ENV` via `docker
image inspect`, which only answers for an image that's already on the host — so for an
  unpulled image the buttons simply weren't there, indistinguishable from an image that
  declares nothing. `ImageDefaults` now reports `present`, and each field offers the pull in
  place of its suggestions button, re-inspecting when it finishes. The pull is a read here:
  nothing in the stack is started or recreated.

- **Per-host feature availability.** Agents now probe their own machine for what it can
  actually do — ZFS, systemd, Docker — and report the result on `identify`, so the control
  plane knows before it acknowledges the connection. Probes are native (filesystem and
  `/proc` checks in `apps/server/src/agent/host-capabilities.ts`), not shelled out, so they
  distinguish _installed_ from _usable_: ZFS tools without a loaded kernel module, a Docker
  socket the agent's user can't open, or `systemctl` present on a host that isn't actually
  booted with systemd all report unavailable with an explanation rather than a working tab
  that errors on click. A feature declares what it needs via
  `descriptor.requiresHostCapability`; the matching server tab greys out in the sidebar for
  hosts that reported it missing, stays clickable, and explains the gap with a **Re-check**
  button (`redetectHostCapabilities`) that re-runs the probes without waiting for a
  reconnect. The probe itself is declared on the feature — an `AgentFeature` exported
  alongside the control-plane one and registered in `agent/features.ts`, giving the feature
  system a node-side half. A capability the agent never reported — an older agent, or an offline host — is
  treated as _unknown_ and renders normally, so nothing greys out on a reconnect flicker.

### Fixed

- **A compose stack whose directory was deleted reported "down" while its containers were still running.**
  Every compose command runs as `cd <dir> && docker compose …`, so once the
  directory is gone they all fail at `cd` — and the status view read that as "no services,
  nothing running", contradicting the container counts shown right next to it. Status now
  falls back to plain `docker ps` filtered by the project's own
  `com.docker.compose.project` label, which survives whatever happened to the directory. In
  the same pass, containers running under a service the compose file no longer declares are
  listed too, instead of being silently dropped from the services table.

- **Apps with a compose file that docker rendered as YAML showed no services.** The App
  system asks docker for `config --format json`, but some compose builds print the canonical
  YAML regardless of the flag; the output then failed `JSON.parse`, so Import reported
  "Couldn't read services from the compose file" and the imported App listed zero services
  and a **down** badge while its containers were happily running. Compose's output is now
  read in either shape (`parseComposeConfigOutput`) — it's the same canonical document, so
  service names, images, named volumes and long-form bind mounts all survive the fallback.

### Changed

- **Container detail moved into a drawer beside the list.** Docker → Containers lists
  containers as two-line cards instead of a table, and clicking one opens its detail next to
  the list rather than in a modal over it, so the list stays put. The open container is in the
  URL; below 1400px the list steps aside and the drawer takes the page. New **Logs** and
  **Volumes** tabs — Volumes browses the container's mounts with the host file browser.

- **One status vocabulary and one action pattern across the Docker section.** A state reads
  the same everywhere: a stopped stack now matches the stopped containers inside it. Rows
  carry one contextual primary action plus an overflow menu instead of four buttons, with
  destructive actions menu-only.

- **Apps became compose stacks, and moved under the host's Docker tab.** What shipped as
  the "App system" was only ever a UI over one `docker compose` project — a directory, a
  compose file, and `volumes/` — so it is now named that: `App` is `ComposeStack` end to
  end (`listComposeStacks`/`createComposeStack`/…, `ComposeStackStore`,
  `apps/server/src/features/compose/`), and the top-level **Apps** nav item is gone. Stacks
  live in **Server → Docker → Compose stacks** ("compose" spelled out throughout, so nothing
  reads as a Swarm stack), which now shows one merged list instead of two disjoint ones:
  stacks SC _registered_ — with a detail page, and actions that work even when every
  container is down — alongside what's actually running. That merge retires the "orphaned"
  concept: a registered stack with no containers is just down.

  **Running stacks are adopted automatically.** Opening a host's Compose stacks section
  registers any compose project running there that SC has no record of, using the compose
  path from its own containers' `config_files` label. Adoption is control-plane only —
  nothing is written to the host — and it takes the project name from the label rather than
  predicting it from the directory, so actions keep addressing the project its containers
  actually belong to. A project whose containers carry no usable compose path can't be
  placed and still lists as **no compose path**, without a detail page.

  This is groundwork: `App` is being freed for a layer _above_ stacks (identity, routes,
  backup policy, templates), which is fleet-scoped and doesn't belong on a host tab. The
  fleet-wide "every stack on every server" list goes away with this change and is expected
  to return as that layer's list.

  **Removing a stack is now two named outcomes** instead of one action with a checkbox:
  _Down and unregister_ (just _Unregister_ when nothing is running) leaves the folder where
  it is, and _Delete folder_ removes the directory outright behind a type-the-name confirm.
  Both take containers down first when the stack is running — a stack left running with
  nothing managing it would only be adopted straight back on the next read.

  **The stack detail page lost its Controls tab.** Stack-wide actions
  (Start / Restart / Stop / Pull & up / Down) are a toolbar on Overview, directly under the
  Host / Directory / Project chips; per-service actions moved into a "…" menu on each row of
  the services table; and Remove sits top-right in the header next to the status badge. The
  services table also links each service to its container's detail page — routed now
  (`#/server/:id/docker/containers/:containerId`), so a container page can be linked to and
  survives a reload, with the list behind it scoped to that stack. The stack page's
  "Run command" box is gone; container exec already lives on the container page, which is
  where it belongs.

  **The stack detail view's Volumes tab is now Files**, rooted at the stack's own folder
  next to its compose file rather than a subfolder. New stacks no longer get a scaffolded
  `volumes/` directory: bind mounts go wherever the compose file points them, and an empty
  folder SC invented was a convention that existed only to be explained. Existing stacks are
  unaffected — a `volumes/` folder that's already there is just a folder, and still browsable.

  Migration is automatic and needs no action: `.sc-data/app-registry.json` is read on
  startup when `.sc-data/compose-stacks.json` doesn't exist yet, and the next write
  supersedes it — the old file is left in place rather than deleted. On managed hosts the
  per-directory manifest is now `sc-stack.json`; `sc-app.json` is still recognised on
  detect/import and replaced when a directory is imported.

- Every feature's `api.ts` is now `feature.ts`, and each opens with its `create<X>Feature`
  factory — the feature's entry point reads first, with the operation slice and task
  handlers below it.

## [0.10.0] - 2026-08-18

### Added

- **App system v1** (design: [doc/idea_app_system.md](doc/idea_app_system.md)): a new **Apps**
  section (sidebar + `#/apps`) for managing docker-compose stacks directly, alongside the
  existing container-id-based Docker tab. An App is `{ id, name, hostId, dir, composeFile,
project, createdAt }` (`AppStore`, `.sc-data/app-registry.json`); Apps list = cards grouped by
  server, App detail = tabbed Overview/Compose/Volumes/Controls/Logs matching the server-overview
  sub-tab pattern. Create (single modal, writes a fresh compose file) and Import (stepped modal,
  detects an existing compose project on disk) both go through `DirectoryPicker`. A new
  `docker_compose_action` task kind (`up`/`restart`/`stop`/`down`, optional `pullFirst`, optional
  per-service scoping) drives `docker compose -f <path> -p <project> <verb>` off the App's own
  directory — works even on a fully-down App with zero containers, unlike the existing
  container-id-based `docker_stack_action`. Status/services come from `docker compose ps`/
  `config --format json`, good enough for the status badge + services table (a fuller
  running/disk/reconcile merge is future work, `doc/idea_stack_registry.md` §2).
  - **Visual compose editor**: the Compose tab can edit `docker-compose.yml` as a form (image,
    command, ports, env, volumes mapped under the app's `volumes/` directory) instead of raw YAML,
    validated live against the official Compose Specification JSON schema (`ajv`, vendored schema
    in `apps/web/src/lib/`) plus a server-side `docker compose config` semantic check
    (`validateComposeContent`). Anything the visual form doesn't model falls back to a YAML tab —
    the compose file is always the source of truth, there's no SC-native service format.
  - Reclaimed the `App` name: the old OIDC relying-party admin screen (`listApps`/`createApp`/
    `deleteApp`) is renamed to `OidcClient`/Settings → "SSO Clients" so the two don't collide.
  - Not yet built: the streaming-exec primitive for `up`/`pull` (they run over the existing 30s
    `exec()`, so a single end-of-command log line and a hard 30s ceiling — same known limitation
    `docker_image_pull` already has); reverse-proxy routes, app-provided OIDC/auth roles, and
    per-section reconcilers stay deliberately out of scope for v1.
  - Follow-up same day: `DeleteAppModal` now shows `HostName (id)` instead of a raw uuid and
    requires typing the app name before "Delete folder & remove app" enables; `DirectoryPicker`'s
    empty-directory row now reads "(empty directory)" instead of looking like a phantom file;
    creating/importing an app now navigates straight to it instead of just reloading the list;
    the Overview services table links published host ports directly (`http://<host-ip>:<port>`).

- **ZFS integration** (design: [doc/idea_zfs.md](doc/idea_zfs.md)): a new per-server **ZFS** tab
  (Pools/Datasets/Snapshots sections) for full lifecycle management, not just a capacity readout —
  grayed out on hosts without the `zpool`/`zfs` binaries. Pools: health/vdev/device tree, scrub
  start/stop, import/export, a guided create-pool wizard and add-vdev/replace-device wizards that
  only ever offer `/dev/disk/by-id/*` paths (never unstable `/dev/sdX`) and cross-check every
  candidate disk against every host's `zpool status` plus the mount table — in-use disks are
  visibly disabled with a reason, not just discouraged after the fact. Datasets: create/destroy
  (filesystem or zvol), common property editing (compression, quota, recordsize, atime, readonly,
  mountpoint, canmount). Snapshots: create (recursive optional), destroy, rollback (shows the count
  of newer snapshots it would also destroy before confirming), clone. A new **Mounts** tab
  (`host-mounts.ts`/`MountsView.tsx`) complements it — cross-references `findmnt` against
  `/etc/fstab` and ZFS `canmount` so it can flag a mount as auto vs. manual.
  - **Safety rails, not a v2 concern**: no silent `-f` anywhere in generated commands — a refused
    op surfaces the refusal for the operator to resolve, never a force-flag checkbox. Every
    genuinely destructive action (pool/dataset destroy, snapshot rollback) goes through a new
    type-to-confirm `ConfirmDangerModal` (`ui.tsx`) requiring the exact pool/dataset/snapshot name,
    not a generic "Are you sure?". Pool/vdev topology changes (create, destroy, add vdev, replace
    device, import/export) are owner-only; dataset/snapshot CRUD is owner+admin; operator/viewer
    get read-only views. Every mutation — even ones that complete in milliseconds — runs through
    the task system as one of 13 new `zfs_*` task kinds, purely for the audit trail.

- **Terminal into a container**: the container details modal's new "Terminal" tab opens a real
  interactive shell inside the container (`docker exec -it`), reusing the same `TerminalView`/xterm
  plumbing as the host terminal — copy-on-select and the leave confirmation below both apply here
  too. Threaded through the existing `openShell` protocol bridge rather than a new one: `openShell`
  gained an optional `command`, built and validated by the control plane exactly like `execRequest`'s
  (same container-id check as the one-shot exec below); when set, the agent spawns it in the PTY
  instead of a login/runuser shell, and it overrides `asUser` — exec'ing into a container is its own
  identity boundary, not a host OS user. Tries bash first, falling back to `sh` for minimal images —
  written as `command -v bash && exec bash; exec sh` rather than the more obvious `exec bash || exec
sh`, since POSIX has `exec` failing to find its target abort a _non-interactive_ shell outright
  instead of continuing on to `||`, which silently 127'd on every bash-less image (alpine included)
  during testing.

- **Docker exec quick-command box**: a small "run one command, see the output" input (new `ExecBox`
  component, `ui.tsx`) — a one-shot, non-interactive wrapper around `docker exec`/`docker compose
exec`, for scripty one-liners that don't need a full shell. Lives in an "Exec" tab on the container
  details modal (`dockerContainerExec`, by container id) and a "Run command" section on the App
  page's Controls tab (`appServiceExec`, by compose service name, so the App page never needs to
  know container ids). Shows stdout, stderr, and the exit code; doesn't throw on a non-zero exit
  since the typed command is arbitrary and the point is seeing exactly what it printed either way.

- **Terminal: copy-on-select and a leave confirmation**. Highlighting text in the terminal now
  copies it to the clipboard automatically (mirrors the "copy on select" convention most desktop
  terminals use), so Ctrl+C can stay reserved for SIGINT instead of being overloaded as a copy
  shortcut. Separately, navigating away from an open terminal (in-app navigation, browser back/
  forward, closing the tab, or refreshing) now asks for confirmation first instead of silently
  killing the session — gated on the session having been open for at least 5 seconds
  (`terminalSession.ts`) so a fast accidental open-then-navigate doesn't nag.

- **Reusable copy button** (`CopyButton`/`CodeBlock`, `ui.tsx`): a small icon button with a
  checkmark confirmation, and a wrapper that pins one to the corner of any monospaced text block.
  Applied to the container details modal's raw JSON tab, the systemd unit-file detail modal, and
  the ZFS pool wizard's generated command preview.

### Fixed

- **Copy buttons silently did nothing when the control plane was reached over plain HTTP**:
  `navigator.clipboard` is only defined in a secure context (HTTPS or localhost), so every hand-rolled
  `navigator.clipboard.writeText(...)` call was a silent no-op on a plain-HTTP LAN deployment — no
  error, the button just didn't work. A new shared `copyToClipboard()` (`apps/web/src/utils.ts`)
  falls back to the `document.execCommand("copy")` trick when the async API isn't available; every
  copy button in the app now goes through it.

## [0.9.0] - 2026-08-11

### Added

- **File browser: download button.** The open-file editor pane gained a Download button
  (text, binary, and image files) that builds the file client-side from the already-loaded
  buffer — no new server endpoint. Disabled for truncated files (only a partial preview was
  loaded, so a "download" would silently be incomplete).

- **Linux arm64 builds**: releases now ship `sc-agent-linux-arm64` alongside the existing
  x64/mac/windows binaries (`scripts/build-agent.sh`, release workflow, `binary-store.ts`'s
  `SUPPORTED_PLATFORMS`), so the lazy binary registry can serve arm64 agents on demand and
  arm64 hosts can install the control plane directly.
- **Per-machine Vite dev-server override** (`apps/web/vite.config.local.example.ts`): copy to
  the gitignored `vite.config.local.ts` for machine-specific dev settings (e.g. `server.host`/
  `allowedHosts` for tailnet access) without touching the committed config.
- **File browser upload cap raised 64MB → 256MB** (`MAX_UPLOAD_BYTES`). Two things had to move
  with it or the raised limit wouldn't actually work: the control plane's HTTP server now sets
  an explicit `maxRequestBodySize` (sized off `MAX_UPLOAD_BYTES` with base64's ~4/3 overhead
  plus margin) since Bun's ~128MB default would otherwise 413 a large upload before it reached
  the handler; and `uploadFile`'s control-plane→agent request now gets its own 120s timeout
  (`UPLOAD_TIMEOUT_MS` in `host-agent.ts`) instead of the 30s default sized for quick RPCs,
  since a few-hundred-MB transfer over a slow link could plausibly miss that window.

### Fixed

- **File browser: multi-file upload aborted the whole batch on the first failure** (e.g. one
  oversized file among several selected) instead of continuing with the rest. Each file is now
  attempted independently and failures are collected into one combined error message; an
  oversized file is now also rejected client-side against the shared `MAX_UPLOAD_BYTES` before
  it's read and base64-encoded, instead of only after the wasted work.

## [0.8.0] - 2026-07-27

### Added

- **Agent heartbeat**: the control plane now sends a `ping` every 15s to agents advertising the new
  `heartbeat` capability (once immediately on connect, so the agent's watchdog arms right away), and
  the agent replies `pong`. The point is the receiving side: an agent that has seen a beat and then
  goes 45s without one (`SC_AGENT_HEARTBEAT_TIMEOUT_MS` to override) declares the link dead,
  terminates the socket, and reconnects. TCP alone never resolved this — on a half-open connection
  (NAT table eviction, gateway reboot) the agent kept writing metrics into a void indefinitely and
  never reconnected, since `runWithUrl`'s promise only settled on a close/error that never arrived.
  The watchdog arms only after the first beat, so an older control plane that never pings keeps the
  previous behaviour instead of reconnect-looping; the beat is capability-gated so older agents
  (which have no watchdog to feed) aren't pinged at all. The socket is torn down with `terminate()`
  rather than `close()`, and the watchdog resolves the connection promise itself — waiting on a close
  handshake the dead peer will never answer is exactly the stall being escaped. Server side, the node
  server's WS `idleTimeout` is now an explicit 60s (Bun's default is 120s), halving how long a
  half-open connection lingers in the fleet; agents send metrics every 5s, so live ones clear it
  easily.

- **Agents remember which control URL worked** (`state.json`): the working endpoint is persisted and
  tried first on the next reconnect _and_ across restarts. Previously the configured order
  (`--control`, then `--alt-control`) was retried from the top every single time, so a host that only
  reaches the control plane via the alt endpoint — the normal case off-LAN, where the primary is a
  LAN address — paid a full failed attempt on every reconnect, forever. Every 10th reconnect cycle
  ignores the memory and re-probes the configured order, so an agent that fell back to the alt
  re-discovers the (cheaper, LAN-local) primary once it's reachable; a remembered URL that's no
  longer configured is ignored outright, so stale state can't strand an agent. State lives in
  `state.json` next to the install's cert/config (or under `SC_AGENT_DIR`/`~/.sc-agent` for a live
  agent) — deliberately _not_ in `config.json`, which is operator/installer-authored input rewritten
  wholesale by `installSelf`. Writes are atomic (temp + rename) and entirely best-effort: the file is
  a cache, and losing it costs one slower reconnect.

### Fixed

- **The data-dir test isolation didn't cover `bun test` from the repo root**: the SC_DATA_DIR pin
  added earlier lives in `apps/server/test/env-preload.ts`, wired via `apps/server/bunfig.toml` —
  but Bun only reads bunfig from the directory it was invoked in, so running the suite from the repo
  root (which is what a monorepo-wide `bun test` does) skipped the preload entirely and put
  `CONFIG_DIR` back to the relative `.sc-data`, reopening the exact race that clobbered a live dev
  instance's `agents.json`. Two fixes: a root `bunfig.toml` mirroring the preload, and — since a
  config detail shouldn't be the only thing standing between a test run and real data — a backstop
  in `config.ts` that resolves the data dir to a throwaway temp dir whenever `NODE_ENV=test` (which
  `bun test` always sets) and SC_DATA_DIR is unset. Verified from the repo root: `CONFIG_DIR` lands
  under /tmp and a full suite run leaves the real `.sc-data/agents.json` byte-identical. The agent
  side got the same treatment — `SC_AGENT_DIR` is now pinned in the preload so spawned test agents
  keep their `state.json`/machine-id fallback out of the developer's home directory.

- **An agent could hang forever on a single control-plane connect attempt**: `connect()` had no
  deadline at all, so an attempt was bounded only by the OS. A black-holed endpoint (dropped SYN —
  the usual shape of "that address isn't reachable from this host") burned ~127s of TCP SYN retries
  before failing over to the alt URL, and a peer that accepted the socket but never sent
  `acknowledged` wedged the loop permanently: no alt attempt, no reconnect, no recovery short of a
  restart. Now bounded by a 10s deadline covering TCP + TLS + the WS upgrade + the acknowledgement —
  the same guard the self-update download already had (`DOWNLOAD_TIMEOUT_MS`) for the identical
  failure shape. Covered by `apps/server/test/integration/agent-reconnect.test.ts`, which points a
  real agent at a listener that accepts and never speaks and asserts it falls through to the alt.

- **Task runs left "Running" forever after a control-plane restart**: `TaskRunner` persists every
  status transition, so a run in flight when the process stopped stayed on disk as `pending` or
  `running` — and `TaskStore.init()` replayed it verbatim. Nothing could ever move it to a terminal
  state: the run's execution context (abort controller, log buffer, in-flight promise) lives only in
  the process that started it, and no other process owns these runs, so the zombie sat in the task
  list until 200 newer runs pruned it out. Most visible with `update_agent`, the one kind that
  legitimately stays `running` for minutes while it waits for the agent to reconnect. `init()` now
  reaps them: any run loaded as `pending`/`running` is by definition orphaned, so it's marked
  `failed` with "Interrupted by a control-plane restart; the outcome is unknown." and stamped with
  the reap time as `finishedAt` (the true end time is unknowable, and leaving it unset would make
  the UI's duration tick up forever). Idempotent — a second boot finds nothing left to reap.

- **Test suite could silently corrupt a real running dev instance's `.sc-data`**: several
  integration tests (`fleet-priority`, `agent-connect`, `agent-update-download`, `binary-store`,
  `update-agent-task`) isolate `config.ts`'s data dir by `process.chdir()`-ing to a per-test tmp
  dir — but `Fleet.register()`/`deregister()` persist fire-and-forget, so a write still in flight
  when a test's `afterAll` restored `cwd` could resolve its _relative_ `.sc-data/...` path against
  the real repo directory instead. This wasn't hypothetical — it clobbered a real `bun run dev`
  instance's `apps/server/.sc-data/agents.json` mid-session. Fixed by forcing `SC_DATA_DIR` to one
  absolute, test-run-only directory before any test file loads (`apps/server/test/env-preload.ts`,
  wired via `apps/server/bunfig.toml`'s `[test] preload`) — an absolute path is immune to `cwd`
  entirely, so no chdir race anywhere in the suite can land a write outside it again. Verified by
  hashing the real `.sc-data/*.json` files across repeated full test runs. Follow-on fixes this
  exposed: `binary-store.test.ts` had hardcoded the literal `.sc-data/config.json` path instead of
  going through `config.ts`'s own `writeConfig()`/`CONFIG_DIR`, which broke once `CONFIG_DIR` was
  no longer always ".sc-data" — switched to the real exports; and since `CONFIG_DIR` is now one
  fixed directory for the whole run instead of fresh per test, its binary cache leaked between
  tests — now cleared explicitly per test.
- **Duplicate `/events` broadcasts (doubled task log lines, etc.)**: React StrictMode's dev-only
  double mount/unmount of the connection effect (`App.tsx`) called `connectionManager.stop()` then
  `start()` back to back; `stop()`'s `ws.close()` doesn't wait for the close handshake, so the old
  socket's `onmessage` stayed live and both it and the new socket were registered server-side for a
  moment, each delivering the same event. Fixed in `apps/web/src/connection.ts`: `stop()` now strips
  the old socket's handlers before closing it, and every handler double-checks `this.ws === ws`
  before acting, so a stale connection can never apply an event or clobber state a newer one set.

### Added

- **Agent update waits for the actual reconnect, not just the ack**: `update_agent` no longer
  reports `succeeded` the moment the agent acknowledges the update — it now polls the fleet
  (`apps/server/src/tasks/types.ts` `waitForAgentReconnect`) until a _new_ connection for that
  machine comes back online (proof it actually disconnected to swap its binary and restart). If
  that new connection reports the wrong version (not `force`), the run fails immediately with a
  clear "Agent reconnected on X, expected Y" error instead of continuing to poll — a real
  connection has already committed to a version, so it's not going to change on its own, and this
  is exactly what surfaced a genuine control-plane/agent-binary version mismatch in the dev
  workflow. `force` skips the version check entirely (a same-version re-push can't be told apart
  from the old connection by version string alone), settling for "reconnected" there. Times out
  after 5 minutes if it never reconnects at all. This didn't need the task system's deferred
  resume-across-reconnect work — the control plane process itself never restarts here, only the
  remote agent's connection drops, so the run's promise just keeps waiting in place. New test:
  `apps/server/test/integration/update-agent-task.test.ts` drives a real `Fleet`/`HostAgent` (no
  sockets) through reconnect-with-right-version, reconnect-with-wrong-version, and timeout cases.
- **Force reinstall for a broken agent install**: `installNodeService` gained an optional `force`
  flag that bypasses the "already installed" refusal and overwrites the existing cert/config/
  binaries (restarting the systemd unit afterward so the overwrite actually takes effect). The
  Setup Wizard offers this as a checkbox once an "already installed" error comes back, so a
  partial/broken prior install can be repaired without SSHing in to clean it up by hand.
- **Dev-build agent updates**: `scripts/build-agent.sh` now stamps `AGENT_VERSION` with a
  `-dev.<git-sha>[.dirty]` suffix (via a new generated `shared/src/build-info.generated.ts`,
  same restore-on-exit pattern as `web-assets.generated.ts`) whenever it's run without
  `RELEASE=1` — so a local rebuild is a distinguishable, traceable version instead of an
  unchanged `x.y.z` that the update flow silently refused to re-push. CI's release workflow
  sets `RELEASE=1` to keep tagged releases on plain `x.y.z`. Fleet agent updates also gained an
  explicit `force` option (`updateNodeService` op, `updateService` node-protocol message,
  `apps/server/src/agent/agent-cli.ts#updateSelf`) that bypasses the version-equality check, for
  re-pushing a rebuild whose version string didn't change (e.g. no new commit). `AgentsView`'s
  per-agent action is now always available for online installed agents — "Update" when outdated,
  "Force update" otherwise.
- **Task widget + live task modal**: a bottom-right corner widget (`TaskWidget`) shows in-flight
  task runs app-wide with a short log tail; clicking one — or a running row in the Tasks view —
  opens `TaskModal`, a live status+log view driven by the same WS state as everywhere else (no
  polling). A new `taskModalManager` singleton (`apps/web/src/taskModal.ts`) makes the modal
  openable from anywhere without prop-drilling. `runTaskAndWait` gained an opt-in `autoOpenModal`
  flag, used by the agent-update and docker-image-pull call sites (slow/opaque actions worth
  watching); quick actions (service/container start-stop) keep their existing inline busy-state.
  Shared per-kind formatting moved to `apps/web/src/taskFormat.ts` so the widget, modal, and
  `TasksView` don't each duplicate the exhaustive spec/result switches. The modal's header now
  carries a status accent (`Modal`'s new optional `tone` prop, `ui.tsx`) — blue with a spinner
  while running/pending, green on success, red on failure, gray if cancelled — instead of a plain
  title bar, via `taskFormat.ts`'s new `modalTone()`. The spinner is a small reusable `.spinner`
  CSS class (colored by `currentColor`) shared with the corner widget's pill.
- **Agent update is a task kind**: `update_agent` (`shared/src/tasks.ts`) replaces the standalone
  `updateNodeService` RPC — the pre-update checks (agent connected, mode `installed`, already
  up to date unless `force`) moved into its task handler (`apps/server/src/tasks/types.ts`), which
  still only waits for the agent's acknowledgment (not the restart itself), same as before. This
  was safe to do without the task system's still-deferred "resume across reconnect" capability
  (`docs/task-system.md` §8.5) precisely because the run already completes at the ack point, before
  the agent's WS connection drops for the actual binary swap. `AgentsView`'s Update/Force update
  buttons now call `runTaskAndWait()` like the other fleet actions, gaining run history + logs.
- **Four more task kinds**: service start/stop/restart/enable/disable, docker stack actions
  (start/stop/restart/down), docker container actions (start/stop/restart/pause/unpause/remove),
  and `docker pull` are now `service_action`/`docker_stack_action`/`docker_container_action`/
  `docker_image_pull` task kinds instead of plain RPCs — every action now gets run history and a
  captured log of its output for free. `ServicesView`, `DockerStacks`, `DockerContainers`, and
  `DockerImages` all call the new `runTaskAndWait()` helper (`apps/web/src/api.ts`) instead of the
  old direct ops, which are removed (`handler.ts`, `shared/src/index.ts`) now that nothing calls
  them. The underlying `systemdServiceAction`/`dockerStackAction`/`dockerContainerAction`/
  `dockerImagePull` functions (`systemd.ts`/`docker.ts`) gained an optional `onLog` callback,
  passed through as `ctx.log` from the new task handlers, so command construction + validation
  stayed in one place instead of being duplicated for task use. `docker_image_pull` keeps the
  original semantics where a failed pull is a normal `{ ok: false }` result, not a thrown error —
  the task still reports `succeeded`.
- **Task run history + logs UI** (design: [docs/task-system.md](docs/task-system.md) §8.2): new
  "Tasks" sidebar view lists every run (control-plane and per-server), live via the existing
  `taskUpdate` event, filterable by kind/status; expanding a row shows spec/result/error and, for
  kinds that log (`cmd`), the run's output. Runner now emits a `taskLog` event per log line
  (`apps/server/src/tasks/runner.ts`, capped at 2000 lines/run in memory — still not persisted
  across a control-plane restart) alongside a new `getTaskLogs` op to seed a run's buffer on
  first view; `apps/web/src/components/TasksView.tsx` and `connection.ts` (`taskLogs` state) are
  the client half. Logs/cancellation/schedules remain otherwise deferred (§8.1, §8.3).
- **Per-node STUN check**: the Network view's "Check STUN" button runs the existing `find_wan_ip`
  task targeted at that server, so it discovers the public IP from _that host's_ network vantage
  point rather than only the control plane's. New `stunRequest`/`stunResponse` node-protocol
  messages and a `stun` agent capability (`apps/server/src/agent/agent.ts`,
  `apps/server/src/host-agent.ts#discoverStun`); `find_wan_ip`'s task handler now branches on
  `ctx.agent` to pick control-plane-local vs. agent-targeted STUN
  (`apps/server/src/tasks/types.ts`). Complements the existing `remoteIp` (WS source IP as seen by
  the control plane).

### Fixed

- **Terminal**: last line was slightly clipped — `FitAddon` reads padding off the `.xterm` element
  itself, not its parent, so padding lived on the wrong element (`.terminal-host`) and the fit math
  didn't agree with the visual inset. Moved padding onto `.xterm`; also refit once
  `document.fonts.ready` resolves, since cell metrics measured before the monospace font loads are
  slightly off.
- **Terminal ctrl-w**: browsers reserve Ctrl+W for closing the tab and don't let a page override
  that, so it never reached the shell's word-delete. Ctrl+Backspace now sends the same control byte
  (`\x17`) as a working alternative (`apps/web/src/components/TerminalView.tsx`).

## Pre-0.8

## 2026-07-13 - Reverse proxy v1 (SC-managed Caddy)

### Added

- **Reverse proxy** (design: [doc/idea_reverse_proxy.md](doc/idea_reverse_proxy.md)): SC deploys
  and manages a Caddy container on one designated node and renders proxy routes into its config.
  HTTP(S) only; routes store intent (`host → {node, published host port}`) and the renderer
  resolves LAN-IP upstreams uniformly (same-node and cross-node identical in v1). Deferral ladder
  recorded in the doc: shared docker network → DOCKER-USER restriction → WireGuard mesh;
  decided against ever tunneling app traffic through SC.
  - Server: `apps/server/src/proxy/` — `ProxyStore` (`.sc-data/proxy.json`), Caddy JSON renderer
    (admin listener re-declared so /load can't lock SC out; internal-CA or ACME cert modes), and
    `ProxyManager` (detached pull+run bring-up under a `sc.proxy` label, `caddy run --resume`,
    admin API published loopback-only, atomic `POST /load` config pushes, remove keeps volumes).
  - Protocol: new `httpRequest` node message — the agent performs a local `fetch()` and returns
    status + body, for endpoints only reachable from the host's vantage point (Caddy's
    loopback-bound admin API now; reachability probes later). Older agents ignore it (request
    times out).
  - Ops (owner-only): `getProxyState`, `setProxyConfig`, `deployProxy`, `removeProxy`,
    `createProxyRoute`/`updateProxyRoute`/`deleteProxyRoute` (mutations re-apply config
    asynchronously; outcome in `lastApply`), `applyProxyConfig`.
  - Web: new **Proxy** view (sidebar + `#/proxy`) — setup card (node, cert mode, ACME email),
    container status with deploy/redeploy/remove, routes table + add/edit modal, 5s state poll.
  - Tests: renderer unit tests (`test/integration/proxy-caddy.test.ts`); ops verified against a
    netns-isolated control plane. Real dockerd bring-up not yet exercised (none in this dev env).
- **Configurable proxy host ports** (`ProxyConfig.httpPort`/`httpsPort`, defaults 80/443) for
  nodes where 80/443 are taken — the first real-host deploy hit exactly that (TrueNAS web UI on
  80). Container-internal side stays 80:443; UI notes the ACME/redirect caveat for non-standard
  ports.
- **"View container in Docker →" link** on the Proxy page (when the container exists): jumps to
  the proxy node's Docker → Containers pre-filtered to `sc-proxy` for inspect/logs/actions. The
  containers filter is now route-carried (`…/docker/containers?q=<filter>`), so any view can
  deep-link a container; the Stacks drill-in keeps its local-state path.
- **Deploy-failure feedback** on the Proxy page: container status now carries `docker inspect
.State.Error` when the container exists but isn't running (e.g. "failed to bind host port …:
  address already in use"), or a recent deploy-log tail when a failed `docker run` left no
  container; the view renders it as a red status line.

- **Agent capability advertisement** (`AGENT_CAPABILITIES`, `identify.capabilities`): agents
  ignore unknown control-message kinds, so sending `httpRequest` to a pre-httpRequest agent died
  as a silent 30s protocol timeout ("Request <uuid> timed out" on Apply config). Agents now
  advertise their post-v0.6.0 message kinds at identify; `HostAgent.httpRequest` fails fast with
  "The agent on <node> (<version>) predates HTTP-request support — update the agent" instead.
  The embedded agent always carries the current set. Pattern to extend for future message kinds.

### Fixed

- **Docker action errors were truncated to the useless line**: `firstErrorLine()` returned only
  the _last_ line of a failed docker command's output — for `docker start` that's the generic
  "Error: failed to start containers: <id>" summary, hiding the daemon's actual reason on the
  line above. Replaced with `errorText()` returning the full (bounded) output, so container/
  stack/volume/image action failures now show the real cause in the UI banner.

## 2026-07-04 - System users: per-host Users tab + terminal impersonation

### Added

- **System user mapping** (`UserInfo.systemUser`, set via `setUserSystemUser`, owner-only): a
  Server Central user can be mapped to an OS account, edited in Settings → Users (new column +
  expanded-row form). Their terminal then runs as that account on every host: the control plane
  resolves the mapping at shell-open (`resolveShellUser` in `apps/server/src/system-users.ts`)
  and the agent wraps the PTY spawn in `runuser -l <user>` (falls back to `su -`; requires the
  agent to run as root, which installed agents do).
- **Terminal policy — deny by default**: unmapped owner/admin still get the agent's own user
  (root) so admins aren't locked out; unmapped operator/viewer get no terminal at all, with a
  clear error in the terminal pane. Mapping someone to `root` is the explicit root-terminal grant.
- **Per-server Users tab** (`SystemUsersView`, route tab `users`): lists real accounts from
  `getent passwd`/`getent group` (uid ≥ 1000 plus root; daemons/nobody hidden) with uid, groups,
  home, shell, and which SC users map to each. "Add user" (owner-only, `systemUserCreate`) runs
  `useradd -m` with optional supplementary groups and prefers `/bin/bash` as the login shell.
- **Mapped-hosts view**: Settings → Users now shows, under the mapping form, where the mapped
  account actually exists — a "missing on <hosts>" badge (`systemUserHostStatus`: per-host
  exists/missing/offline/error via `getent passwd <name>`, exit 2 = missing, uid filter lifted so
  mapped daemon accounts still count) and a "Mapped hosts…" modal (`MappedSystemUsersModal`) with
  a one-click "Create account" on missing hosts and supplementary-group editing on existing ones
  (`systemUserSetGroups`, owner-only, `usermod -G`; `SystemUserInfo.primaryGroup` added so the UI
  can split primary from supplementary). Accounts are never created implicitly — creation is
  always an explicit owner action, here or in the per-server tab.

### Notes

- Protocol: `openShell` gained `asUser` — an **outdated installed agent silently ignores it and
  opens a root shell**, so update agents before relying on the mapping (noted in next.md).
- File operations, exec, docker, and systemd are still root-backed regardless of mapping; this
  slice covers terminals only. Verified end-to-end via a root agent harness: `runuser` shell
  reports the target identity and home, unknown users fail visibly, non-root agents refuse.

## 2026-07-02 - Rename SSO clients to Apps (placeholder for a future App system)

### Changed

- **"SSO Clients" renamed to "Apps"** end to end: shared `OidcClient` type → `App`, API ops
  `listOidcClients`/`createOidcClient`/`deleteOidcClient` → `listApps`/`createApp`/`deleteApp`,
  `OidcClientsTab.tsx` → `AppsTab.tsx`, Settings tab id `sso` → `apps`. Storage file renamed
  `.sc-data/oidc-clients.json` → `apps.json` (no migration — pre-release, nothing to carry over).
  This is purely a rename: an App today is still just an OIDC relying-party registration
  (id/secret/redirect URIs). It's a placeholder ahead of a bigger App-system concept (compose
  stacks, reverse-proxy routes, app-provided auth roles) that isn't designed yet — see the new
  entry in `next.md`.

### Notes

- That `next.md` entry also captures a related idea to design later: `Role` needs to become a set
  of roles per user (not one value) so app-provided roles and standalone permissions (e.g. a
  "terminal access" role) can be assigned independently.

## 2026-07-02 - User sessions, admin password reset, issuer URL from domain

### Added

- **Expandable user rows** (Settings → Users): click a row to see last-active time, a list of that
  user's active sessions (created, last active, IP, device/user-agent), and a "Change password" form.
  Sessions carry `id`/`ip`/`userAgent` now (`auth.ts`); pre-existing session records without them are
  backfilled with a fresh id on first load.
- **Revoke a session** from the expanded row — refuses to revoke the admin's own current session
  (use logout instead) to avoid an accidental self-lockout mid-request.
- **Admin password reset** (`adminSetPassword`): owner sets a new password for any account; all of
  that user's sessions are revoked immediately so the change takes effect right away.
- **Derive issuer URL from the external domain**: once an External domain is saved (Settings →
  General), a button next to the OIDC Issuer URL field fills in `https://{domain}` — still requires
  an explicit Save.

### Notes

- Per-operation RBAC is still only enforced on the Users/SSO-client admin endpoints — see the new
  note in `next.md`. Every other endpoint (servers, files, docker, systemd, network, tasks, config)
  runs for any authenticated user today regardless of role.

## 2026-07-01 - OIDC identity provider + multi-user accounts

### Added

- **Server Central is now an OpenID Connect provider**, so other self-hosted apps can "log in with Server Central" for SSO. New endpoints: `/.well-known/openid-configuration`, `/.well-known/jwks.json`, `POST /oidc/token` (form-encoded, authorization_code grant with mandatory PKCE/S256), `GET/POST /oidc/userinfo`. Tokens are RS256-signed JWTs; the signing keypair is generated once and persisted (`apps/server/src/oidc/`).
- **Roles exposed as a `groups` claim** on the ID token — the reason this shipped alongside a minimal **Users admin screen** (Settings → Users): owner-only create/list/delete + role assignment (admin/operator/viewer), since an SSO provider needs more than one possible user to be meaningful.
- **SSO Clients admin screen** (Settings → SSO Clients): the owner registers each relying party by hand (name + redirect URIs) — no dynamic client registration. The generated client secret is shown once, hashed like passwords thereafter.
- **`/oidc/authorize` confirmation screen**: reuses the existing login session, then shows "Continue as `{user}` to `{client}`?" instead of a scope-consent checklist, since every client here was already approved by the owner at registration.
- New required **Issuer URL** setting (Settings → General) — the stable base URL used as the JWT `iss` claim; OIDC clients can't be created until it's set.

### Notes

- Access/ID tokens are self-contained JWTs with no revocation list, so they can't be invalidated before expiry — mitigated with short lifetimes (ID token 5 min, access token 1 hour) and no refresh tokens in v1.
- Per-operation RBAC enforcement inside Server Central itself is still not implemented (tracked separately); today only the Users/SSO-client admin ops are owner-gated.

## 2026-07-01 - Expandable rows for containers and services

### Added

- **Click-to-expand rows** on both the Docker containers and systemd services tables. Clicking a row toggles an inline detail drawer instead of jumping straight to a modal, with a leading chevron (`row-expander`) marking expandable rows.
- **Inline log preview** (`LogPreview`): the expanded drawer tails the last 12 log lines for the container/service, with a refresh and an "Open full logs" jump to the existing `LogViewerModal`.
- **Detail metadata in the drawer** via a shared `DetailPair` (lifted out of the container modal into `ui.tsx`): containers show image, stack/service, status, ports, created and short id; services show unit, description, active/sub, loaded and startup state.
- **Container labels** are now parsed by `dockerContainerInspect` (new `labels` field on `DockerContainerDetail`) and listed in the container Inspect modal's Details tab.
- **Expand animation:** the drawer grows the real row height via a `grid-template-rows: 0fr → 1fr` transition (`row-detail-in`, 0.22s) rather than popping to full height and sliding the content — no layout jump. Honours `prefers-reduced-motion`. The log preview auto-scrolls to the newest line on load/refresh.

### Changed

- **Row actions moved into the expanded drawer.** The always-visible per-row action buttons are gone; start/stop/restart/pause, remove/inspect (containers) and start/stop/restart, enable/disable, unit file (services) now live in the drawer, keeping the row itself scannable. Container Inspect still opens the full inspect modal.
- **Uniform filter placement.** The systemd Services search + status filter + Refresh moved out of the page `view-header` into a `panel-head` inside the Services panel, matching where the Docker containers filters already live.

## 2026-06-29 - Unified log viewer for Docker and systemd

### Added

- **One log viewer for both Docker containers and systemd services.** systemd logs now render in the same ANSI-aware `LogViewer` (search, wrap) that Docker already used, replacing the plain `<pre>`. A new `LogViewerModal` wrapper owns the fetch controls so both sources share them.
- **Exposed log controls:** line limit (200/500/1k/5k), time window (`since`: 15m/1h/6h/24h), and an oldest-vs-newest order toggle. Source-specific extras: journald severity filter (`-p err/warning/info/debug`) and a Docker timestamps toggle. Plus a live line count, Copy, and Download.
- **Bigger window.** Log modals now open near-fullscreen (`Modal` gained a `large` variant with a flex-fill body, sized 96vw × 94vh) instead of the old fixed-width modal.
- **More legible data tables.** Zebra striping and a clear row hover (so it's obvious which row's buttons you're clicking), plus a status-colored accent bar and row tint — applied to the Docker containers and systemd services tables via `row-status-{ok,warn,err}`.
- **Status filters** on both tables, as an inline segmented control (shared `StatusFilter`) so every state is visible at once with a live count and a status-colored dot: systemd services by Active/Inactive/Failed (replacing the old "Active only" checkbox) and Docker containers by Running/Paused/Stopped, keyed to the same status tokens as the row colors.

### Changed

- `dockerContainerLogs`/`systemdServiceLogs` API ops now take a shared `LogQuery` (`limit`/`order`/`since`) plus their source-specific option. Backend translation (journald `--since`/`-p`/`--reverse`, Docker `--since`/`--timestamps`, line-reversal for Docker newest-first) lives in `apps/server/src/log-query.ts`.

### Deferred

- Live follow/tail mode — needs a streaming exec RPC (current `runExec` is one-shot); the `LogViewerModal` Refresh button is the interim.

## 2026-06-28 - Task system (first slice: WAN IP check)

### Added

- **A control-plane task system.** Tasks are a unit of work the control plane runs (optionally against a host agent), each carrying a uniform envelope — id, status (`pending`/`running`/`succeeded`/`failed`/`cancelled`), a _typed_ result, trigger, and timestamps — so any kind gets run history, last-result inspection, and a "run now" affordance for free. A task's spec is a closed discriminated union keyed by `kind` in `@central/shared` (`TaskSpec` = `TaskCmd | TaskFindWanIp`), with a parallel `TaskResult` union on the same `kind`; the server has one handler per kind (`apps/server/src/tasks/types.ts`, `taskHandlers`), mirroring the API operation layer. Adding a kind = spec variant + result variant + handler.
- **Runner + store.** `TaskRunner` owns the lifecycle (status transitions, resolved-agent + cancellation context, broadcasting each change as a `taskUpdate` event); `TaskStore` persists runs to `.sc-data/tasks.json`, newest-first, capped at 200. New API ops `runTask`/`listTasks`/`getTask`; the `/events` `init` payload now seeds recent runs so the web client has history on connect.
- **First migrated kind: `find_wan_ip`** (control-plane STUN, wrapping `discoverWanIp`). Settings has an "External (WAN) IP" card with a "Check now" button that starts the task and shows the latest run's IP + timestamp, updating live over the events socket.
- Deferred for later slices (wire types already present where noted): scheduled tasks (`TaskSchedule`), task logs (`TaskLogLine`), cancellation, and agent-targeted kinds (e.g. per-node STUN, agent update with resume-across-reconnect).

## 2026-06-27 - Control-plane self-update from the web UI

### Added

- **Control-plane self-update.** Settings now shows the control plane's running version and, when it's installed as a service and a newer release exists, an "Update to X" button. It downloads the control plane's own-platform binary for the latest release (checksum-verified via the binary store), points the `sc-central` symlink at it, and exits so systemd re-execs the new version — mirroring the host-agent self-update. Two new API ops: `getControlPlaneStatus` (current/latest version + `updateAvailable`) and `updateControlPlane`.
- **Latest-release lookup** (`getLatestVersion` in `binary-store.ts`): queries the GitHub releases/latest API derived from the release-source base URL (or `releaseSource.latestUrl` for a custom mirror), cached 10 min so UI polling doesn't exhaust the anonymous rate limit. A failed check degrades to "no update offered" rather than erroring.

## 2026-06-27 - Single-binary control-plane self-install

### Added

- **The control plane installs itself**, like a host agent does. `sc-agent --install-server [--install-dir … --data-dir … --mechanism systemd|manual]` copies the running binary to a versioned path, points a stable `sc-central` symlink at it, and supervises it (systemd `Restart=always`, or a returned start command for "manual"). Running the bare binary on a TTY offers the same interactively with sensible defaults; the installed unit runs with no TTY so it skips the prompt and just boots. Combined with the lazy binary registry, **installing the control plane is now a single downloaded file** that needs no other platform binaries up front.
- **`SC_DATA_DIR`** env override for the control plane's state dir (config, TLS, tokens, agent-binary cache), defaulting to `.sc-data` in dev. The installed unit sets it to the data dir (default `/var/lib/sc-central`) so the service is location-independent.

### Changed

- **Extracted the shared self-install primitives** (`agent/self-install.ts`): service layout, atomic symlink swap, versioned-binary pruning (rollback), exec/writable preflight, manifest, and the systemd unit writer — now parameterized by a `ServiceSpec` (name + description) and used by both the host agent and the control plane. `agent-cli.ts` keeps only its agent-specific cert/config handling on top. No behavior change for agents.

## 2026-06-27 - Control plane as a lazy agent-binary registry

### Added

- **Lazy binary store** (`binary-store.ts`). The control plane no longer needs every platform's agent binary present on disk to serve agents. It resolves a requested `(os, arch)` binary in order: local cache (`<dataDir>/agent-binaries/sc-agent-<platform>-<version>`) → `dist/` (dev/custom builds) → **release source** (download, verify, cache). Agents still only ever download from the control plane; this just backfills what the control plane is missing, the first time a platform is actually requested. A homogeneous fleet never fetches the other platforms. `dist/` taking precedence keeps the dev/test loop offline, and dropping a binary into `dist/`/the cache (or pointing the release source elsewhere) is the custom-build hook.
- **Release-source config** (`Config.releaseSource`: `baseUrl` + optional `token`). Defaults to this repo's public GitHub Releases (`…/releases/download/v<version>/<asset>`); override for a self-hosted/custom or authenticated mirror.
- **Checksum integrity.** The release workflow now emits a `SHA256SUMS` asset, and the store verifies a downloaded binary against it before caching/serving — **failing closed** on a missing entry or mismatch. The control plane hands these binaries to root-running agents, so an unverified one is RCE; the agent→control-plane hop is already cert-pinned, so this closes the control-plane→source hop.

### Changed

- `NodeServer` serves `/node-binary` and `/node-bootstrap` via the store instead of reading `dist/` directly; store errors map to HTTP statuses (400 unsupported platform, 404/502 source failures). Concurrent requests for the same uncached platform are de-duped to a single download.

## 2026-06-27 - All-in-one binary serves the web UI + release CI

### Added

- **Embedded web UI.** The compiled binary now serves the React SPA itself, so a single `sc-agent-*` file is the whole product (control plane + host agent + UI) with no separate static host. A new codegen step (`scripts/gen-web-assets.ts`) scans the Vite `dist/` output and emits `apps/server/src/web-assets.generated.ts`, which statically imports every asset with `{ type: "file" }` so `bun build --compile` bundles them into the binary. `static.ts` resolves request paths against that map — exact-match assets get `immutable` caching, unknown extensionless paths fall back to `index.html` for client-side routing, and missing files 404. Served on the same `:4141` as the API, so the existing `location.hostname:4141` API base is same-origin with no config. The committed generated file is empty (dev still serves the UI via Vite); release builds regenerate it.
- **Release CI** (`.github/workflows/release.yml`). On a pushed `v*` tag (or manual dispatch) it typechecks, runs `build:agent` to build the web bundle and cross-compile all three targets, and attaches the binaries to a draft GitHub Release.
- **`bun run release [patch|minor|major|x.y.z]`** (`scripts/create-release.ts`): bumps every workspace `package.json` to one version (kept in lockstep so the `v<version>` tag, `AGENT_VERSION`, and packages never disagree), refreshes the lockfile, and makes a tagged `release v<version>` commit. Requires a clean tree; prints the push commands rather than pushing. Pushing the tag is what fires the release workflow.
- **Architecture in binary names.** Binaries are now `sc-agent-<os>-<arch>` (`sc-agent-linux-x64`, `sc-agent-mac-x64`, `sc-agent-windows-x64.exe`) so arm64 targets can be added later without colliding. The agent/bootstrap report `<os>-<arch>` (`process.arch` / `uname -m`) and the control plane keys `PLATFORM_BINARY` and the `/node-binary` + `/node-bootstrap` routes by that combined key. Only x64 is built today.

### Changed

- **`build:agent`** now builds the web SPA and embeds it before compiling (set `SKIP_WEB=1` to reuse an existing `apps/web/dist`). The web bundle is platform-agnostic, so it's built once up front and shared across all compile targets.
- **`bun.lock` is now committed** (removed from `.gitignore`) so dependency changes show up in diffs and CI installs with `--frozen-lockfile` — catching unintended upgrades.

## 2026-06-24 - Hardening: createDir injection, dispatch isolation, atomic writes, login throttle

### Fixed

- **Command injection in `createDir` (root RCE).** `HostAgent.createDir` ran `mkdir -p "<path>"` through the shell, escaping only `"` — but `$(…)`/backticks still expand inside double quotes, so an authenticated path like `/tmp/$(reboot)` executed as root. Replaced with a structured `createDirRequest`/`createDirResponse` node-protocol message backed by `fs.mkdir(path, { recursive: true })` on the agent — no shell involved, matching the other file ops. This was the only file operation still going through `exec`.
- **HTTP dispatch could index arbitrary handler properties.** The router did `handler[command]` straight off the URL path, so a path like `/constructor` or `/toString` resolved to prototype members. Handler methods are now prefixed (`login` → `handleLogin`, etc.) via a new `ApiHandlerPrefixed<T>` mapped type in `@central/shared`, and the dispatcher derives `handle<Capitalize<command>>` before indexing — a request can now only ever reach an explicitly-defined `handle*` method. (Stopgap until the spec layer is reworked with richer per-op metadata / zod.)

### Changed

- **All persisted JSON is now written atomically** (`writeFileAtomic` in `config.ts`: write temp sibling → `rename`). Covers users, sessions, agent state, agent tokens, and config — a crash mid-write can no longer corrupt the user store (locking everyone out) or the durable token store (orphaning every installed agent).

### Added

- **Login throttling.** After `MAX_LOGIN_FAILURES` (10) consecutive failures from one source (client IP, or username when no IP), logins from that source are blocked for `LOGIN_BLOCK_MS` (15 min). Client IP is threaded through `AuthContext.ip` from `server.requestIP()`; a successful login clears the counter.

## 2026-06-22 - File browser: upload, move

### Added

- **File upload** in the file browser. An `Upload` button (multi-select) reads files in the browser, base64-encodes them, and sends them to a new binary-safe `uploadFile` op (`uploadFileRequest`/`uploadFileResponse` over the node protocol) — the agent decodes to a `Buffer` and writes raw bytes, unlike `writeFile`'s utf8-only path. Capped at `MAX_UPLOAD_BYTES` (64 MB) to stay within the control plane's RPC timeout and HTTP body limits.
- **Move** per-row action (↗): prompts for a destination directory and reuses the existing `renamePath` op (`fs.rename` already handles cross-directory moves). Rename was already supported.

## 2026-06-22 - Observability: trace the agent self-update flow

### Added

- **`[update]`-prefixed logging across the self-update path** so a stuck or failed update can be traced end to end without guesswork. Control plane logs the `updateNodeService` trigger (current → target version, agent state/mode), the agent's acknowledgement, and each `/node-binary` fetch (served or token-rejected). The agent logs the incoming `updateService` request and any handler failure, and `updateSelf`/`downloadBinary` log resolved install/data dirs, each binary URL attempted (with per-attempt success bytes/duration or failure reason), the symlink repoint, and the pending restart.

## 2026-06-22 - Fix: node self-update hung instead of falling through / reporting

### Fixed

- **Agent self-update no longer black-holes on an unreachable endpoint.** `downloadBinary` tried the URLs (`control` then `altControl`) in order but its `fetch` had no deadline, so when the primary endpoint was unreachable from the agent (e.g. it had connected via the alt endpoint), the connect stalled indefinitely: it never errored, never fell through to the working alt, and never reported anything. The control plane's 30s RPC timeout fired first, surfacing only a generic "timed out" with no binary downloaded. Each download attempt now has a deadline (`DOWNLOAD_TIMEOUT_MS`), sized so trying every URL still fits inside the RPC timeout — a dead endpoint aborts and falls through to the next, and an all-endpoints failure now propagates the real error (with the URLs tried) upstream.
- The download also writes to a temp sibling and renames into place, so a failed/partial download can't leave a corrupt versioned binary for the stable symlink to point at.

## 2026-06-22 - Docker rework (Portainer-lite)

### Added

- **Nested Docker menu**: the Docker tab is now a sub-tabbed view (Overview · Stacks · Containers · Volumes · Images), routed as `#/server/<id>/docker/<section>`. `routes.ts` gained `DockerSection` plus encode/decode (including a volume-browser drill-down `…/docker/volumes/<name>/<path>?f=<file>`); the view shell lives in `components/docker/`.
- **Overview**: container running/total, stack, volume and image counts plus `docker system df` disk-usage cards (`dockerOverview`).
- **Stacks**: compose stacks detected from `com.docker.compose.project` labels (no compose binary needed), with running/total badge, states, config-files, and Start/Stop/Restart/Down actions (`dockerStacks`/`dockerStackAction`); clicking a stack jumps to its containers.
- **Containers**: filterable table (name/image/stack), pause/unpause added to the existing start/stop/restart/remove, a **Container detail** modal (`dockerContainerInspect`: state, command, ports, mounts, env, networks, restart policy, and a Raw inspect JSON tab), and richer logs.
- **Volumes**: inspect (mountpoint, labels, attached containers via `dockerVolumeInspect`), remove (`dockerVolumeRemove`), and a **file browser** that reuses `FilesView` rooted at the volume mountpoint.
- **Images**: remove (`dockerImageAction`) and pull a new image (`dockerImagePull`).
- **Reusable log viewer**: `components/LogViewer.tsx` + `ansi.ts` render ANSI/SGR colors as styled spans and add find-in-text (highlight, prev/next, match counter) and a wrap toggle. Built to be reused by other log surfaces (e.g. systemd) later. Still fetches all logs (tail 2000) — pagination/streaming is future work.

### Changed

- `ContainerInfo` now carries derived `project`/`service` (parsed from compose labels); `ContainerAction` gained `pause`/`unpause`. `DockerView` was split from one flat screen into the section components above.

## 2026-06-22 - Networking and Systemd host menus

### Added

- **Network host tab**: a new per-server "Network" view (`getNetworkInfo` → `network.ts`) lists adapters, addresses, and routes via iproute2's JSON output (`ip -j addr` / `ip -j route`), parsed into typed `NetworkInterface`/`NetworkAddress`/`NetworkRoute`. Falls back to an "unavailable" state when `ip -j` isn't present.
- **Remote IP detection of agents**: the control plane now records the source IP of each agent's WebSocket connection (its public IP across NAT, mirroring the control plane's own WAN discovery). Captured at upgrade via `server.requestIP(req)`, carried on `HostAgent.remoteIp` and `ServerStatus.remoteIp`, and surfaced in the Network view. Null for the embedded host.
- **Services (systemd) host tab**: a new per-server "Services" view (`systemdList`/`systemdServiceAction`/`systemdServiceLogs`/`systemdUnitFile` → `systemd.ts`) lists service units merged from `list-units` (runtime state) and `list-unit-files` (enabled/disabled), with filter + active-only toggle, start/stop/restart/enable/disable controls, and modals for `journalctl` logs and `systemctl cat` unit files. Unit names are validated before use in commands.

## 2026-06-21 - Enroll over a domain/WAN address (CA-based TLS)

### Added

- **"Use external address" toggle in Add Node**: `generateNodeInstallCommand` takes `useExternal` and returns the control plane's `externalHost` (configured domain, else discovered WAN IP, or null). When set, `NodeServer.endpoints` swaps the install command's primary host from the LAN IP to that external host (keeping the LAN address as the off-LAN-style alt), so a machine that isn't on the control plane's network can be enrolled. The unix bootstrap carries the choice as `?external=1` on `/node-install/<token>` so the separately-fetched script renders the same endpoints. The Add Node dialog shows the checkbox only when an external host is known and regenerates the command on toggle.

### Changed

- **TLS is now a private CA + a re-issuable leaf** (was a single self-signed cert). `ensureTls(dir, { domain, wanIp, lanIps })` generates a long-lived CA once and issues a CA-signed **leaf** whose SAN covers the addresses agents actually connect to (`control-plane`, `localhost`, `127.0.0.1`, the LAN IPs, the WAN IP, and the configured domain). Agents embed the **CA** as their trust anchor (`/node-cert` and the bootstrap's embedded cert now serve `caCertPem`), so the leaf can be renewed or expanded with a new domain/IP **without re-enrolling any agent** — the new leaf still chains to the same CA. The one-time install download still pins the current leaf's pubkey.
- **Agents connect by domain.** The agent dropped the `servername: "control-plane"` workaround and connects with just `tls: { ca }`. Bun's `WebSocket` enforces hostname↔SAN at the TLS layer and ignores `checkServerIdentity`/`servername` for the identity check, so the old fixed-servername scheme only worked for IP literals and failed for real domains (`TLS handshake failed`). Verification is now hostname-correct via the leaf SAN.
- **Domain changes apply live.** `setDomain` re-issues the leaf and rebinds the node listener (Bun's `server.reload()` does not hot-swap TLS), so a domain set from the web UI takes effect without a restart.

### Migration

- On first start after this change the control plane generates its CA and replaces the old self-signed `server.crt` with a CA-signed leaf. Any **already-installed** agent still pinning the old self-signed cert must be re-enrolled (re-run Add Node); live/embedded agents are unaffected. Going forward, cert renewals and SAN changes no longer require re-enrollment.

## 2026-06-21 - Smaller fleet/files polish (embedded mode, delete servers, image preview, auto-continue setup)

### Added

- **`embedded` agent mode**: the control plane's own in-process host now reports `mode: "embedded"` (was `installed`) and outranks live/installed in the fleet, so it always stays the active connection for its machine. `installNodeService` rejects it with a clear message ("the control plane's own host can't be installed as a service").
- **Delete servers**: `deleteServer` op + `Fleet.remove()` forget a known agent. Only _offline_ agents can be removed (connected agents — including the embedded host — are rejected, since they'd just reappear). Agents view shows a **Delete** action on offline rows.
- **Auto-continue setup after enrollment**: the Add Node dialog now watches the fleet for the freshly-enrolled live agent and surfaces a "Continue setup" banner that hands straight off to the `SetupWizard` — no more closing the dialog and hunting for the agent in the Agents view.
- **Image preview in the file browser**: the agent base64-encodes recognized image types (`png/jpg/jpeg/gif/webp/bmp/ico/svg/avif`, up to 16 MB) and `FileContent` carries `encoding`/`mimeType`; `FilesView` renders them inline on a checkerboard backdrop instead of the "binary — not editable" placeholder.

### Changed

- **`AGENT_VERSION` is sourced from `package.json`** (`shared/package.json` `version`) instead of a hardcoded string, so there's a single place to bump the agent/control-plane version.

## 2026-06-21 - Interactive, frontend-driven agent setup (configurable paths, config file)

### Added

- **Guided setup wizard** (`SetupWizard` + `DirectoryPicker`): the Agents view's old "Install as service" button (a one-shot `installNodeService({ serverId })` to fixed paths) becomes a "Complete setup" wizard. On a normal host it offers a one-click systemd install to the defaults (`/usr/local/bin` binary + `/var/lib/sc-agent` data); when the agent reports the defaults are unusable (read-only root / noexec mount, e.g. TrueNAS) or the user customizes, `DirectoryPicker` browses the agent's filesystem (via `listDir`), creates folders, and live-validates each candidate dir as writable + exec-capable.
- **Configurable install + data dirs**: `installNodeService`/`installService` now carry `installDir` (binary) and `dataDir` (cert/config/state/exec-scratch), so the agent can install onto a writable storage pool when the OS root isn't usable.
- **Agent config file**: an installed agent launches from `<dataDir>/config.json` via `sc-agent --agent --config <path>` (control URLs, durable token, cert path, mode, install/data dirs); self-update resolves its paths from the config.
- **Two persistence mechanisms**: `mechanism: "systemd"` writes/enables a unit; `mechanism: "manual"` lays down files, best-effort starts the agent detached, and returns a `startCommand` for the operator to wire into their own init system (e.g. a TrueNAS POSTINIT Init/Shutdown script, or cron `@reboot`) — vendor-neutral, no appliance-specific code.
- `probeInstallPath` op (`probeInstallPathRequest`/`probeInstallPathResponse`) backed by a `probeDir` exec-probe helper (`mounts.ts`); `SystemInfo.install` (`{ defaultInstallDir, defaultDataDir, defaultsUsable }`) reports default-path usability. Integration test covers `probeInstallPath` end-to-end.

### Changed

- **Bootstrap** is now a templated `bootstrap.sh` (served at `/node-install/<token>`) instead of the inline `curl … -o /tmp/sc-agent` one-liner: it downloads the binary + cert into the current directory, runs the live agent in the foreground, and removes the staged files on exit (trap). Requires `$PWD` (or `$SC_STAGE`) to be writable + exec.
- The installed agent's cert/config/state moved from a fixed `/etc/sc-agent` to the chosen data dir (default `/var/lib/sc-agent`); the binary default stays `/usr/local/bin`.

### Fixed

- **Portable agent binary**: `bun run build:agent` now compiles via a pinned **official** Bun (`scripts/build-agent.sh`, cached under `.toolchain/`) instead of whatever `bun` is on PATH. A distro-packaged bun is dynamically linked to the build host's system ICU + libatomic, and `bun build --compile` embeds that runtime, so the agent failed on hosts lacking those exact libs (TrueNAS: `libatomic.so.1`, then `libicui18n.so.78` not found). The official release statically bundles ICU and targets old glibc, so the linux binary now needs only base glibc (`libc`/`libm`/`libpthread`/`libdl`/`ld-linux`).

## 2026-06-20 - Agent code folder + brace style sweep

### Changed

- Agent-side modules moved into `apps/server/src/agent/`: `agent.ts`, `agent-cli.ts`, `machine-id.ts`, `embedded-agent.ts`. Control-plane modules (`host-agent.ts`, `fleet.ts`, `node-server.ts`, etc.) stay in `apps/server/src/`. Imports rewired; typecheck + tests green.
- Code style: expanded all single-line control-flow bodies (`if (c) stmt`) into braced blocks across `apps/server` and `apps/web` (127 sites). No behavioral change.

## 2026-06-20 - Agent self-update mechanism

### Added

- Installed agents can be updated to the control plane's current `AGENT_VERSION` from the Agents view. The agent downloads the new binary from the control plane (`GET /node-binary/<token>/<platform>`, durable-token authed, cert-pinned), writes it as a versioned file (`/usr/local/bin/sc-agent-<version>`), atomically repoints the stable `sc-agent` symlink the systemd unit execs, and exits so `Restart=always` re-execs into the new version. The previous binary is kept (last 2 versions) for future rollback.
- Protocol: `updateService`/`updateServiceResponse` messages and the `updateNodeService` op.
- UI: per-agent "Update" button and version warning in `AgentsView`, plus a ⚠ badge on the Agents sidebar nav item when any installed agent is behind. Detection (`isAgentOutdated`) is client-side.

### Changed

- `installSelf` now uses the versioned-binary + symlink layout: it drops `/usr/local/bin/sc-agent-<version>` and points the stable `sc-agent` symlink (referenced by the systemd unit) at it, so the unit no longer embeds a version and never needs rewriting on update.

## 2026-06-20 - Node/agent refactor: merge node into server (f1bc20d)

### Changed

- `apps/node` is gone; the agent now lives in the server and runs via `sc-server --agent --control … --token … --cert …`. The same single binary is both the control plane (no args) and the host agent (`--agent`); `apps/server/src/index.ts` dispatches on `--agent` before booting the control plane.
- Source moved into `apps/server/src/`: `agent.ts` (the host-side `Agent` runner, transport-abstracted), `machine-id.ts`, and `agent-cli.ts` (the `--agent` connect/reconnect loop, `WsTransport`, self-install).
- Collapsed the confusing trio to two clear types: `Agent` (runs on the host) and `HostAgent` (the control plane's handle to any host — formerly `NodeProxy`). The embedded host is now just `createEmbeddedAgent()` — a `HostAgent` whose transport feeds an in-process `Agent`. No more per-method forwarding.
- Build retargeted: `bun run build:agent` compiles the server entry into `dist/sc-agent-{linux,mac,windows}`; the install command + systemd `ExecStart` invoke the binary with `--agent`.

### Removed

- `LocalAgent` and the `RemoteAgent`/`NodeProxy` split.

## 2026-06-20 - Add-server wizard / self-install flow

### Added

- A live agent connects & verifies, then the Agents view offers "Install as service" for online live agents → `installNodeService` → the control plane mints a durable per-machine token and sends `installService` to the live agent.
- The agent writes the binary+cert to stable paths, installs+enables a systemd unit (`--mode installed` with the durable token), errors if a unit already exists, then exits so the installed service takes over (fleet demotes the live connection).
- Durable per-machine tokens persisted in `.sc-data/agent-tokens.json` (`NodeServer.mintAgentToken`, accepted by `validateToken`), since short-lived enrollment tokens (30m) would expire for an installed service.

### Changed

- The pasted install command runs the agent with `sudo` (it manages the host and installs a root systemd service). Windows command unchanged (self-install is Linux-only).

## 2026-06-20 - Stable machine ids & agent modes (live/installed)

### Added

- Agents resolve a stable machine id (`machine-id.ts`: hashed `/etc/machine-id`, else a persisted UUID) sent in `identify`. The fleet keys on it, so reconnects/duplicates collapse to one entry instead of a new random instance each time.
- `AgentMode = "live" | "installed"` sent in `identify` (`--mode`, default `live`; embedded agent is `installed`). The fleet picks the highest-priority connection per machine as active (installed > live); the loser is demoted to a standby (metrics suppressed). `acknowledged` now carries `active` so an agent knows if it's the standby.

## 2026-06-20 - Web: route state in the URL

### Added

- Hash-based routing (`routes.ts` routeToHash/hashToRoute + `hooks/useHashRoute.ts`). The route carries view/server/tab and, for the files tab, the folder path + open file (`#/server/<id>/files/<path>?f=<file>`). `FilesView` is controlled by the route.

### Removed

- The old localStorage-backed route.

## 2026-06-20 - TLS bundle moved into .sc-data

### Changed

- The control-plane TLS bundle now lives under `.sc-data/tls` (`ensureTls(path.join(CONFIG_DIR, "tls"))`); dropped the separate `.sc-tls` gitignore entry. Old certs in `.sc-tls` are abandoned (regenerated fresh in the new location).
