# Changelog

All notable changes to Server Central are recorded here. Newest first. Each
entry is a task/feature headed `# YYYY-MM-DD - Title (commit)`, with
Keep-a-Changelog sections (Added / Changed / Removed / Fixed).

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
