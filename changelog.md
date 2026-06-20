# Changelog

All notable changes to Server Central are recorded here. Newest first. Each
entry is a task/feature headed `# YYYY-MM-DD - Title (commit)`, with
Keep-a-Changelog sections (Added / Changed / Removed / Fixed).

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
