# Next items to implement

## Smaller items

- "already installed" during agent install
  - We should have a force option to overwrite config, certs, and binaries.
  - This is to fix a potentially broken install

## Big tasks pending design, do not automatically implement these unless prompted specifically

### Docker revamped

Docker is big, so i think we need to revamp it, basically embed some of the most used features of portainer into server-central

#### Nested menus

Turn it into a nested menu with several sub sections (maybe an overview?)

- Stacks (detected from labels, compose stacks and such?)
- Containers
- Volumes
  - File browser
  - View what containers is attached
- Images
- Better log viewing
  - Terminal escape codes
  - Search feature
  - And whatever else improvements we can make
    - Maybe we should have a standard log-viewer component we can do reuse?
    - keep fetching all logs for now, we will deal with pagination/streaming in the feature

### Networking host menu

View network adapters and ip addresses on hosts

We should have remote IP detection of agents (similar to the control plane)

Maybe we could group hosts by subnet as well? food for thought!

### Systemd host menu

System services etc, view logs of services and basic controls and viewing unit files etc?

### Better process list?

But at some point maybe it's better to just jump into htop in the terminal?

# Already implemented, archive

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
  - Build retargeted: `bun run build:agent` compiles the server entry into `dist/sc-agent-{linux,mac,windows}`; the install command + systemd `ExecStart` invoke the binary with `--agent`.
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
