# Changelog

All notable changes to Server Central are recorded here. Newest first. Each
entry is a task/feature headed `# YYYY-MM-DD - Title (commit)`, with
Keep-a-Changelog sections (Added / Changed / Removed / Fixed).

# 2026-06-27 - Control-plane self-update from the web UI

## Added

- **Control-plane self-update.** Settings now shows the control plane's running version and, when it's installed as a service and a newer release exists, an "Update to X" button. It downloads the control plane's own-platform binary for the latest release (checksum-verified via the binary store), points the `sc-central` symlink at it, and exits so systemd re-execs the new version — mirroring the host-agent self-update. Two new API ops: `getControlPlaneStatus` (current/latest version + `updateAvailable`) and `updateControlPlane`.
- **Latest-release lookup** (`getLatestVersion` in `binary-store.ts`): queries the GitHub releases/latest API derived from the release-source base URL (or `releaseSource.latestUrl` for a custom mirror), cached 10 min so UI polling doesn't exhaust the anonymous rate limit. A failed check degrades to "no update offered" rather than erroring.

# 2026-06-27 - Single-binary control-plane self-install

## Added

- **The control plane installs itself**, like a host agent does. `sc-agent --install-server [--install-dir … --data-dir … --mechanism systemd|manual]` copies the running binary to a versioned path, points a stable `sc-central` symlink at it, and supervises it (systemd `Restart=always`, or a returned start command for "manual"). Running the bare binary on a TTY offers the same interactively with sensible defaults; the installed unit runs with no TTY so it skips the prompt and just boots. Combined with the lazy binary registry, **installing the control plane is now a single downloaded file** that needs no other platform binaries up front.
- **`SC_DATA_DIR`** env override for the control plane's state dir (config, TLS, tokens, agent-binary cache), defaulting to `.sc-data` in dev. The installed unit sets it to the data dir (default `/var/lib/sc-central`) so the service is location-independent.

## Changed

- **Extracted the shared self-install primitives** (`agent/self-install.ts`): service layout, atomic symlink swap, versioned-binary pruning (rollback), exec/writable preflight, manifest, and the systemd unit writer — now parameterized by a `ServiceSpec` (name + description) and used by both the host agent and the control plane. `agent-cli.ts` keeps only its agent-specific cert/config handling on top. No behavior change for agents.

# 2026-06-27 - Control plane as a lazy agent-binary registry

## Added

- **Lazy binary store** (`binary-store.ts`). The control plane no longer needs every platform's agent binary present on disk to serve agents. It resolves a requested `(os, arch)` binary in order: local cache (`<dataDir>/agent-binaries/sc-agent-<platform>-<version>`) → `dist/` (dev/custom builds) → **release source** (download, verify, cache). Agents still only ever download from the control plane; this just backfills what the control plane is missing, the first time a platform is actually requested. A homogeneous fleet never fetches the other platforms. `dist/` taking precedence keeps the dev/test loop offline, and dropping a binary into `dist/`/the cache (or pointing the release source elsewhere) is the custom-build hook.
- **Release-source config** (`Config.releaseSource`: `baseUrl` + optional `token`). Defaults to this repo's public GitHub Releases (`…/releases/download/v<version>/<asset>`); override for a self-hosted/custom or authenticated mirror.
- **Checksum integrity.** The release workflow now emits a `SHA256SUMS` asset, and the store verifies a downloaded binary against it before caching/serving — **failing closed** on a missing entry or mismatch. The control plane hands these binaries to root-running agents, so an unverified one is RCE; the agent→control-plane hop is already cert-pinned, so this closes the control-plane→source hop.

## Changed

- `NodeServer` serves `/node-binary` and `/node-bootstrap` via the store instead of reading `dist/` directly; store errors map to HTTP statuses (400 unsupported platform, 404/502 source failures). Concurrent requests for the same uncached platform are de-duped to a single download.

# 2026-06-27 - All-in-one binary serves the web UI + release CI

## Added

- **Embedded web UI.** The compiled binary now serves the React SPA itself, so a single `sc-agent-*` file is the whole product (control plane + host agent + UI) with no separate static host. A new codegen step (`scripts/gen-web-assets.ts`) scans the Vite `dist/` output and emits `apps/server/src/web-assets.generated.ts`, which statically imports every asset with `{ type: "file" }` so `bun build --compile` bundles them into the binary. `static.ts` resolves request paths against that map — exact-match assets get `immutable` caching, unknown extensionless paths fall back to `index.html` for client-side routing, and missing files 404. Served on the same `:4141` as the API, so the existing `location.hostname:4141` API base is same-origin with no config. The committed generated file is empty (dev still serves the UI via Vite); release builds regenerate it.
- **Release CI** (`.github/workflows/release.yml`). On a pushed `v*` tag (or manual dispatch) it typechecks, runs `build:agent` to build the web bundle and cross-compile all three targets, and attaches the binaries to a draft GitHub Release.
- **Architecture in binary names.** Binaries are now `sc-agent-<os>-<arch>` (`sc-agent-linux-x64`, `sc-agent-mac-x64`, `sc-agent-windows-x64.exe`) so arm64 targets can be added later without colliding. The agent/bootstrap report `<os>-<arch>` (`process.arch` / `uname -m`) and the control plane keys `PLATFORM_BINARY` and the `/node-binary` + `/node-bootstrap` routes by that combined key. Only x64 is built today.

## Changed

- **`build:agent`** now builds the web SPA and embeds it before compiling (set `SKIP_WEB=1` to reuse an existing `apps/web/dist`). The web bundle is platform-agnostic, so it's built once up front and shared across all compile targets.
- **`bun.lock` is now committed** (removed from `.gitignore`) so dependency changes show up in diffs and CI installs with `--frozen-lockfile` — catching unintended upgrades.

# 2026-06-24 - Hardening: createDir injection, dispatch isolation, atomic writes, login throttle

## Fixed

- **Command injection in `createDir` (root RCE).** `HostAgent.createDir` ran `mkdir -p "<path>"` through the shell, escaping only `"` — but `$(…)`/backticks still expand inside double quotes, so an authenticated path like `/tmp/$(reboot)` executed as root. Replaced with a structured `createDirRequest`/`createDirResponse` node-protocol message backed by `fs.mkdir(path, { recursive: true })` on the agent — no shell involved, matching the other file ops. This was the only file operation still going through `exec`.
- **HTTP dispatch could index arbitrary handler properties.** The router did `handler[command]` straight off the URL path, so a path like `/constructor` or `/toString` resolved to prototype members. Handler methods are now prefixed (`login` → `handleLogin`, etc.) via a new `ApiHandlerPrefixed<T>` mapped type in `@central/shared`, and the dispatcher derives `handle<Capitalize<command>>` before indexing — a request can now only ever reach an explicitly-defined `handle*` method. (Stopgap until the spec layer is reworked with richer per-op metadata / zod.)

## Changed

- **All persisted JSON is now written atomically** (`writeFileAtomic` in `config.ts`: write temp sibling → `rename`). Covers users, sessions, agent state, agent tokens, and config — a crash mid-write can no longer corrupt the user store (locking everyone out) or the durable token store (orphaning every installed agent).

## Added

- **Login throttling.** After `MAX_LOGIN_FAILURES` (10) consecutive failures from one source (client IP, or username when no IP), logins from that source are blocked for `LOGIN_BLOCK_MS` (15 min). Client IP is threaded through `AuthContext.ip` from `server.requestIP()`; a successful login clears the counter.

# 2026-06-22 - File browser: upload, move

## Added

- **File upload** in the file browser. An `Upload` button (multi-select) reads files in the browser, base64-encodes them, and sends them to a new binary-safe `uploadFile` op (`uploadFileRequest`/`uploadFileResponse` over the node protocol) — the agent decodes to a `Buffer` and writes raw bytes, unlike `writeFile`'s utf8-only path. Capped at `MAX_UPLOAD_BYTES` (64 MB) to stay within the control plane's RPC timeout and HTTP body limits.
- **Move** per-row action (↗): prompts for a destination directory and reuses the existing `renamePath` op (`fs.rename` already handles cross-directory moves). Rename was already supported.

# 2026-06-22 - Observability: trace the agent self-update flow

## Added

- **`[update]`-prefixed logging across the self-update path** so a stuck or failed update can be traced end to end without guesswork. Control plane logs the `updateNodeService` trigger (current → target version, agent state/mode), the agent's acknowledgement, and each `/node-binary` fetch (served or token-rejected). The agent logs the incoming `updateService` request and any handler failure, and `updateSelf`/`downloadBinary` log resolved install/data dirs, each binary URL attempted (with per-attempt success bytes/duration or failure reason), the symlink repoint, and the pending restart.

# 2026-06-22 - Fix: node self-update hung instead of falling through / reporting

## Fixed

- **Agent self-update no longer black-holes on an unreachable endpoint.** `downloadBinary` tried the URLs (`control` then `altControl`) in order but its `fetch` had no deadline, so when the primary endpoint was unreachable from the agent (e.g. it had connected via the alt endpoint), the connect stalled indefinitely: it never errored, never fell through to the working alt, and never reported anything. The control plane's 30s RPC timeout fired first, surfacing only a generic "timed out" with no binary downloaded. Each download attempt now has a deadline (`DOWNLOAD_TIMEOUT_MS`), sized so trying every URL still fits inside the RPC timeout — a dead endpoint aborts and falls through to the next, and an all-endpoints failure now propagates the real error (with the URLs tried) upstream.
- The download also writes to a temp sibling and renames into place, so a failed/partial download can't leave a corrupt versioned binary for the stable symlink to point at.

# 2026-06-22 - Docker rework (Portainer-lite)

## Added

- **Nested Docker menu**: the Docker tab is now a sub-tabbed view (Overview · Stacks · Containers · Volumes · Images), routed as `#/server/<id>/docker/<section>`. `routes.ts` gained `DockerSection` plus encode/decode (including a volume-browser drill-down `…/docker/volumes/<name>/<path>?f=<file>`); the view shell lives in `components/docker/`.
- **Overview**: container running/total, stack, volume and image counts plus `docker system df` disk-usage cards (`dockerOverview`).
- **Stacks**: compose stacks detected from `com.docker.compose.project` labels (no compose binary needed), with running/total badge, states, config-files, and Start/Stop/Restart/Down actions (`dockerStacks`/`dockerStackAction`); clicking a stack jumps to its containers.
- **Containers**: filterable table (name/image/stack), pause/unpause added to the existing start/stop/restart/remove, a **Container detail** modal (`dockerContainerInspect`: state, command, ports, mounts, env, networks, restart policy, and a Raw inspect JSON tab), and richer logs.
- **Volumes**: inspect (mountpoint, labels, attached containers via `dockerVolumeInspect`), remove (`dockerVolumeRemove`), and a **file browser** that reuses `FilesView` rooted at the volume mountpoint.
- **Images**: remove (`dockerImageAction`) and pull a new image (`dockerImagePull`).
- **Reusable log viewer**: `components/LogViewer.tsx` + `ansi.ts` render ANSI/SGR colors as styled spans and add find-in-text (highlight, prev/next, match counter) and a wrap toggle. Built to be reused by other log surfaces (e.g. systemd) later. Still fetches all logs (tail 2000) — pagination/streaming is future work.

## Changed

- `ContainerInfo` now carries derived `project`/`service` (parsed from compose labels); `ContainerAction` gained `pause`/`unpause`. `DockerView` was split from one flat screen into the section components above.

# 2026-06-22 - Networking and Systemd host menus

## Added

- **Network host tab**: a new per-server "Network" view (`getNetworkInfo` → `network.ts`) lists adapters, addresses, and routes via iproute2's JSON output (`ip -j addr` / `ip -j route`), parsed into typed `NetworkInterface`/`NetworkAddress`/`NetworkRoute`. Falls back to an "unavailable" state when `ip -j` isn't present.
- **Remote IP detection of agents**: the control plane now records the source IP of each agent's WebSocket connection (its public IP across NAT, mirroring the control plane's own WAN discovery). Captured at upgrade via `server.requestIP(req)`, carried on `HostAgent.remoteIp` and `ServerStatus.remoteIp`, and surfaced in the Network view. Null for the embedded host.
- **Services (systemd) host tab**: a new per-server "Services" view (`systemdList`/`systemdServiceAction`/`systemdServiceLogs`/`systemdUnitFile` → `systemd.ts`) lists service units merged from `list-units` (runtime state) and `list-unit-files` (enabled/disabled), with filter + active-only toggle, start/stop/restart/enable/disable controls, and modals for `journalctl` logs and `systemctl cat` unit files. Unit names are validated before use in commands.

# 2026-06-21 - Enroll over a domain/WAN address (CA-based TLS)

## Added

- **"Use external address" toggle in Add Node**: `generateNodeInstallCommand` takes `useExternal` and returns the control plane's `externalHost` (configured domain, else discovered WAN IP, or null). When set, `NodeServer.endpoints` swaps the install command's primary host from the LAN IP to that external host (keeping the LAN address as the off-LAN-style alt), so a machine that isn't on the control plane's network can be enrolled. The unix bootstrap carries the choice as `?external=1` on `/node-install/<token>` so the separately-fetched script renders the same endpoints. The Add Node dialog shows the checkbox only when an external host is known and regenerates the command on toggle.

## Changed

- **TLS is now a private CA + a re-issuable leaf** (was a single self-signed cert). `ensureTls(dir, { domain, wanIp, lanIps })` generates a long-lived CA once and issues a CA-signed **leaf** whose SAN covers the addresses agents actually connect to (`control-plane`, `localhost`, `127.0.0.1`, the LAN IPs, the WAN IP, and the configured domain). Agents embed the **CA** as their trust anchor (`/node-cert` and the bootstrap's embedded cert now serve `caCertPem`), so the leaf can be renewed or expanded with a new domain/IP **without re-enrolling any agent** — the new leaf still chains to the same CA. The one-time install download still pins the current leaf's pubkey.
- **Agents connect by domain.** The agent dropped the `servername: "control-plane"` workaround and connects with just `tls: { ca }`. Bun's `WebSocket` enforces hostname↔SAN at the TLS layer and ignores `checkServerIdentity`/`servername` for the identity check, so the old fixed-servername scheme only worked for IP literals and failed for real domains (`TLS handshake failed`). Verification is now hostname-correct via the leaf SAN.
- **Domain changes apply live.** `setDomain` re-issues the leaf and rebinds the node listener (Bun's `server.reload()` does not hot-swap TLS), so a domain set from the web UI takes effect without a restart.

## Migration

- On first start after this change the control plane generates its CA and replaces the old self-signed `server.crt` with a CA-signed leaf. Any **already-installed** agent still pinning the old self-signed cert must be re-enrolled (re-run Add Node); live/embedded agents are unaffected. Going forward, cert renewals and SAN changes no longer require re-enrollment.

# 2026-06-21 - Smaller fleet/files polish (embedded mode, delete servers, image preview, auto-continue setup)

## Added

- **`embedded` agent mode**: the control plane's own in-process host now reports `mode: "embedded"` (was `installed`) and outranks live/installed in the fleet, so it always stays the active connection for its machine. `installNodeService` rejects it with a clear message ("the control plane's own host can't be installed as a service").
- **Delete servers**: `deleteServer` op + `Fleet.remove()` forget a known agent. Only *offline* agents can be removed (connected agents — including the embedded host — are rejected, since they'd just reappear). Agents view shows a **Delete** action on offline rows.
- **Auto-continue setup after enrollment**: the Add Node dialog now watches the fleet for the freshly-enrolled live agent and surfaces a "Continue setup" banner that hands straight off to the `SetupWizard` — no more closing the dialog and hunting for the agent in the Agents view.
- **Image preview in the file browser**: the agent base64-encodes recognized image types (`png/jpg/jpeg/gif/webp/bmp/ico/svg/avif`, up to 16 MB) and `FileContent` carries `encoding`/`mimeType`; `FilesView` renders them inline on a checkerboard backdrop instead of the "binary — not editable" placeholder.

## Changed

- **`AGENT_VERSION` is sourced from `package.json`** (`shared/package.json` `version`) instead of a hardcoded string, so there's a single place to bump the agent/control-plane version.

# 2026-06-21 - Interactive, frontend-driven agent setup (configurable paths, config file)

## Added

- **Guided setup wizard** (`SetupWizard` + `DirectoryPicker`): the Agents view's old "Install as service" button (a one-shot `installNodeService({ serverId })` to fixed paths) becomes a "Complete setup" wizard. On a normal host it offers a one-click systemd install to the defaults (`/usr/local/bin` binary + `/var/lib/sc-agent` data); when the agent reports the defaults are unusable (read-only root / noexec mount, e.g. TrueNAS) or the user customizes, `DirectoryPicker` browses the agent's filesystem (via `listDir`), creates folders, and live-validates each candidate dir as writable + exec-capable.
- **Configurable install + data dirs**: `installNodeService`/`installService` now carry `installDir` (binary) and `dataDir` (cert/config/state/exec-scratch), so the agent can install onto a writable storage pool when the OS root isn't usable.
- **Agent config file**: an installed agent launches from `<dataDir>/config.json` via `sc-agent --agent --config <path>` (control URLs, durable token, cert path, mode, install/data dirs); self-update resolves its paths from the config.
- **Two persistence mechanisms**: `mechanism: "systemd"` writes/enables a unit; `mechanism: "manual"` lays down files, best-effort starts the agent detached, and returns a `startCommand` for the operator to wire into their own init system (e.g. a TrueNAS POSTINIT Init/Shutdown script, or cron `@reboot`) — vendor-neutral, no appliance-specific code.
- `probeInstallPath` op (`probeInstallPathRequest`/`probeInstallPathResponse`) backed by a `probeDir` exec-probe helper (`mounts.ts`); `SystemInfo.install` (`{ defaultInstallDir, defaultDataDir, defaultsUsable }`) reports default-path usability. Integration test covers `probeInstallPath` end-to-end.

## Changed

- **Bootstrap** is now a templated `bootstrap.sh` (served at `/node-install/<token>`) instead of the inline `curl … -o /tmp/sc-agent` one-liner: it downloads the binary + cert into the current directory, runs the live agent in the foreground, and removes the staged files on exit (trap). Requires `$PWD` (or `$SC_STAGE`) to be writable + exec.
- The installed agent's cert/config/state moved from a fixed `/etc/sc-agent` to the chosen data dir (default `/var/lib/sc-agent`); the binary default stays `/usr/local/bin`.

## Fixed

- **Portable agent binary**: `bun run build:agent` now compiles via a pinned **official** Bun (`scripts/build-agent.sh`, cached under `.toolchain/`) instead of whatever `bun` is on PATH. A distro-packaged bun is dynamically linked to the build host's system ICU + libatomic, and `bun build --compile` embeds that runtime, so the agent failed on hosts lacking those exact libs (TrueNAS: `libatomic.so.1`, then `libicui18n.so.78` not found). The official release statically bundles ICU and targets old glibc, so the linux binary now needs only base glibc (`libc`/`libm`/`libpthread`/`libdl`/`ld-linux`).

# 2026-06-20 - Agent code folder + brace style sweep

## Changed

- Agent-side modules moved into `apps/server/src/agent/`: `agent.ts`, `agent-cli.ts`, `machine-id.ts`, `embedded-agent.ts`. Control-plane modules (`host-agent.ts`, `fleet.ts`, `node-server.ts`, etc.) stay in `apps/server/src/`. Imports rewired; typecheck + tests green.
- Code style: expanded all single-line control-flow bodies (`if (c) stmt`) into braced blocks across `apps/server` and `apps/web` (127 sites). No behavioral change.

# 2026-06-20 - Agent self-update mechanism

## Added

- Installed agents can be updated to the control plane's current `AGENT_VERSION` from the Agents view. The agent downloads the new binary from the control plane (`GET /node-binary/<token>/<platform>`, durable-token authed, cert-pinned), writes it as a versioned file (`/usr/local/bin/sc-agent-<version>`), atomically repoints the stable `sc-agent` symlink the systemd unit execs, and exits so `Restart=always` re-execs into the new version. The previous binary is kept (last 2 versions) for future rollback.
- Protocol: `updateService`/`updateServiceResponse` messages and the `updateNodeService` op.
- UI: per-agent "Update" button and version warning in `AgentsView`, plus a ⚠ badge on the Agents sidebar nav item when any installed agent is behind. Detection (`isAgentOutdated`) is client-side.

## Changed

- `installSelf` now uses the versioned-binary + symlink layout: it drops `/usr/local/bin/sc-agent-<version>` and points the stable `sc-agent` symlink (referenced by the systemd unit) at it, so the unit no longer embeds a version and never needs rewriting on update.

# 2026-06-20 - Node/agent refactor: merge node into server (f1bc20d)

## Changed

- `apps/node` is gone; the agent now lives in the server and runs via `sc-server --agent --control … --token … --cert …`. The same single binary is both the control plane (no args) and the host agent (`--agent`); `apps/server/src/index.ts` dispatches on `--agent` before booting the control plane.
- Source moved into `apps/server/src/`: `agent.ts` (the host-side `Agent` runner, transport-abstracted), `machine-id.ts`, and `agent-cli.ts` (the `--agent` connect/reconnect loop, `WsTransport`, self-install).
- Collapsed the confusing trio to two clear types: `Agent` (runs on the host) and `HostAgent` (the control plane's handle to any host — formerly `NodeProxy`). The embedded host is now just `createEmbeddedAgent()` — a `HostAgent` whose transport feeds an in-process `Agent`. No more per-method forwarding.
- Build retargeted: `bun run build:agent` compiles the server entry into `dist/sc-agent-{linux,mac,windows}`; the install command + systemd `ExecStart` invoke the binary with `--agent`.

## Removed

- `LocalAgent` and the `RemoteAgent`/`NodeProxy` split.

# 2026-06-20 - Add-server wizard / self-install flow

## Added

- A live agent connects & verifies, then the Agents view offers "Install as service" for online live agents → `installNodeService` → the control plane mints a durable per-machine token and sends `installService` to the live agent.
- The agent writes the binary+cert to stable paths, installs+enables a systemd unit (`--mode installed` with the durable token), errors if a unit already exists, then exits so the installed service takes over (fleet demotes the live connection).
- Durable per-machine tokens persisted in `.sc-data/agent-tokens.json` (`NodeServer.mintAgentToken`, accepted by `validateToken`), since short-lived enrollment tokens (30m) would expire for an installed service.

## Changed

- The pasted install command runs the agent with `sudo` (it manages the host and installs a root systemd service). Windows command unchanged (self-install is Linux-only).

# 2026-06-20 - Stable machine ids & agent modes (live/installed)

## Added

- Agents resolve a stable machine id (`machine-id.ts`: hashed `/etc/machine-id`, else a persisted UUID) sent in `identify`. The fleet keys on it, so reconnects/duplicates collapse to one entry instead of a new random instance each time.
- `AgentMode = "live" | "installed"` sent in `identify` (`--mode`, default `live`; embedded agent is `installed`). The fleet picks the highest-priority connection per machine as active (installed > live); the loser is demoted to a standby (metrics suppressed). `acknowledged` now carries `active` so an agent knows if it's the standby.

# 2026-06-20 - Web: route state in the URL

## Added

- Hash-based routing (`routes.ts` routeToHash/hashToRoute + `hooks/useHashRoute.ts`). The route carries view/server/tab and, for the files tab, the folder path + open file (`#/server/<id>/files/<path>?f=<file>`). `FilesView` is controlled by the route.

## Removed

- The old localStorage-backed route.

# 2026-06-20 - TLS bundle moved into .sc-data

## Changed

- The control-plane TLS bundle now lives under `.sc-data/tls` (`ensureTls(path.join(CONFIG_DIR, "tls"))`); dropped the separate `.sc-tls` gitignore entry. Old certs in `.sc-tls` are abandoned (regenerated fresh in the new location).
