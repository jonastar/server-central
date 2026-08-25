**Alpha stage**

This project is in a very early stage, I would not rely on it for anything mission critical (or rely on it at all).

# Server Central

Server central is a project of mine that aims to be an all in one server/Cluster management tool targeting home servers/homelabs/smaller businesses.

Pictures says more than words, so have some screenshots, then ill go into more details below:

<img width="1640" height="657" alt="Screenshot 2026-08-25 232214" src="https://github.com/user-attachments/assets/37237675-a460-40b2-aa81-980e029cd133" />

<img width="1612" height="957" alt="Screenshot 2026-08-25 232301" src="https://github.com/user-attachments/assets/dee4dade-7c24-4d3f-8269-1e8740d388bb" />

<img width="2872" height="1007" alt="Screenshot 2026-08-25 231537" src="https://github.com/user-attachments/assets/6ab38bc2-b72b-4737-b33c-08e07de3bd89" />

# Features

**implemented** = I use it, **WIP** = works with known gaps, **experimental** = shipped but barely
proven, **unimplemented** = a plan. Full log in [changelog.md](changelog.md), open work in [next.md](next.md).

- **Multi server management** (implemented)
  - This is a core feature
  - Nodes run an agent that self-installs: it downloads itself from the control plane and sets
    up a systemd service on linux
  - Node ↔ control plane traffic is https over a custom CA and self-signed cert — no domain or
    lets encrypt setup needed, still encrypted (the install command you copy carries the pubkey)
  - Agents self-update, and probe their host for what it can actually do (docker, systemd, zfs)
    so unusable tabs grey out instead of erroring
- **Docker management** (implemented, the most built-out part)
  - Containers, images, volumes, logs, inspect, exec, and an interactive shell into a container
  - **Compose stacks**: create, import, or adopt what's already running; up/down/restart/pull,
    stack-wide or per service
  - **Visual compose editor** validated against the Compose Specification and `docker compose
config`, with port/volume/env suggestions read from the image and a device picker for
    passthrough. Anything it can't model falls back to YAML — the compose file is the truth
  - Gap: no streaming exec yet, so `up`/`pull` are capped at 30s
- **ZFS management** (implemented)
  - Pools: health/vdev tree, scrub, import/export, guided create/add-vdev/replace wizards that
    only offer `/dev/disk/by-id/*` paths and refuse disks already in use elsewhere
  - Datasets and snapshots: full lifecycle incl. rollback and clone, plus property editing
  - No silent `-f`, and destructive actions want the exact name typed out
- **Systemd management** (basics implemented)
  - Services list, start/stop/restart/enable/disable, unit file, logs
- **File manager** (implemented)
  - Browse, monaco editor, rename/move/delete/upload/download
  - A **Mounts** view cross-referencing `findmnt`, `/etc/fstab` and ZFS `canmount`, so it can
    tell you a mount won't survive a reboot
- **Terminal** (implemented) — real PTY per host, running as the caller's mapped system user
- **Reverse proxy** (experimental) — SC deploys and manages a Caddy container on one node and
  renders routes (`host → node + port`) into it. Internal CA or ACME
- **Users** (WIP)
  - Owner setup, login, sessions, user CRUD
  - Roles exist (owner/admin/operator/viewer) but **aren't enforced** outside user admin and
    terminals — the biggest hole in the project right now
- **SSO provider** (experimental) — built-in OIDC provider so other apps can sign in against SC, roles as
  a `groups` claim. Largely untested
- **System users** (WIP) — mapping SC users to system users, per-host creation and groups.
  Pending: consistent UIDs across hosts, SSH keys
- **System management**
  - Live and historical metrics, and a process list, per host
  - Networking (WIP) — interfaces, routes, per-node STUN check for the WAN IP
  - Wireguard overlay network (unimplemented)
- **Backups, config tracking & secrets** (unimplemented)
- **An app layer above compose stacks** (unimplemented) — identity, routes, backup policy and
  templates, fleet-scoped rather than per-host

So: running docker and ZFS on a handful of boxes is genuinely usable now; the things that make
it a platform rather than a dashboard — real RBAC, backups, the overlay network — are ahead of me.

# Development

Tests run under `bun test`. Beyond the unit/integration suites there's **the lab**
([apps/server/test/e2e](apps/server/test/e2e)): a throwaway fleet of container "hosts", each
with systemd as PID 1 and its own dockerd, enrolled into an in-process control plane by the
real compiled agent binary. It boots three nodes in about 8 seconds and can be driven by hand,
which makes anything that depends on _which host ran the command_ actually testable.

# Install (control plane)

The whole thing ships as a single self-contained binary (control plane + host agent + web UI). To install the control plane, download one binary for your platform from the latest [GitHub release](https://github.com/jonastar/server-central/releases) and let it install itself:

```sh
# Pick the one matching your platform:
curl -fsSL -o sc-agent https://github.com/jonastar/server-central/releases/latest/download/sc-agent-linux-x64    # Linux x64
curl -fsSL -o sc-agent https://github.com/jonastar/server-central/releases/latest/download/sc-agent-linux-arm64  # Linux arm64
curl -fsSL -o sc-agent https://github.com/jonastar/server-central/releases/latest/download/sc-agent-mac-x64      # macOS x64

chmod +x sc-agent
sudo ./sc-agent --install-server          # or just `sudo ./sc-agent` for an interactive prompt
```

Windows: download `sc-agent-windows-x64.exe` from the [release](https://github.com/jonastar/server-central/releases) page and run `sc-agent.exe --install-server` (or `sc-agent.exe` for the interactive prompt) from an elevated shell.

This installs a `sc-central` systemd service (binary in `/usr/local/bin`, state in `/var/lib/sc-central`) and serves the web UI + API on `:4141`. Override locations with `--install-dir` / `--data-dir`.

You only download the **one** binary for the control plane's own platform. When an agent of another platform enrolls, the control plane fetches that platform's binary from the release source on demand (checksum-verified) and caches it — so agents still install/update by downloading from the control plane, never directly from GitHub. The control plane updates itself from **Settings → Control plane** when a newer release is available.
