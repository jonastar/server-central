# Homelab Hub — Product Spec

## What is it?

A self-hosted control plane for managing a personal homelab. Think of it as a single web UI that ties together all your servers, NAS devices, containers, and network config — without requiring Kubernetes knowledge.

The architecture is a **central manager** (runs on one host, hosts the UI and API) with **lightweight agents** installed on each managed server. Devices that can't run an agent (NAS, router, cloud storage) are registered manually and managed through their own APIs or protocols.

---

## Core Modules

### 1. Devices

The central concept. A device can be one of several types, each with different capabilities:

| Type | Example | Agent? | Capabilities |
|---|---|---|---|
| Server / VM | Ubuntu box, Proxmox VM | Yes | Docker, LVM, filesystem, SSH |
| NAS | Synology, TrueNAS | No (API/SMB/NFS) | Volume sharing |
| Router | OPNsense, Mikrotik | No (API) | DNS, firewall rules |
| Cloud Storage | Backblaze B2, S3 | No (API) | Volume mounting via rclone |

Each device has a status indicator (online/offline/degraded), resource metrics (CPU, RAM, disk), and a list of the volumes and services attached to it.

---

### 2. Services (Docker)

Deploy and manage Docker containers across any agent-equipped device.

- Browse running/stopped containers per device
- Start, stop, restart, remove containers
- View real-time logs (streamed, not polled)
- Deploy new containers with a form UI (image, ports, volumes, env vars, restart policy)
- Pull images, view local image list
- No Kubernetes. No Swarm. Plain Docker per host.

Cross-host networking is handled via a mesh VPN layer (Tailscale or Nebula), allowing containers on different hosts to reach each other by name.

---

### 3. Volumes

Mount storage into services regardless of where it lives.

- **Local volumes** — standard Docker named volumes or bind mounts on the host
- **LVM volumes** — create/resize/delete logical volumes on a device; mount into a container as a bind mount
- **NAS shares** — mount NFS or SMB shares on the agent host, then bind-mount into a container
- **Cloud storage** — mount S3/B2 buckets via rclone as a virtual volume

When deploying a service, volumes from any source are available to attach. The agent handles the actual mount on the host; the manager tracks what is mounted where.

---

### 4. Reverse Proxy

Manage ingress for services running across your devices.

- Add a new proxy rule: domain/subdomain → service:port on a specific device
- TLS via Let's Encrypt (automatic cert provisioning and renewal)
- Support for custom certs
- Basic auth option per route
- The proxy itself runs as a container on a designated device (e.g. Caddy or Traefik under the hood, managed by the Hub)

---

### 5. Networking

High-level view and management of cross-host connectivity.

- Enroll devices into the mesh VPN (Tailscale API or self-hosted Nebula)
- See which devices are connected and their mesh IPs
- DNS management — set internal hostnames that resolve across the mesh
- Port forwarding rules (pushed to router via API if supported)
- No deep packet inspection or firewall rule management in v1

---

### 6. Files

Lightweight file access for config editing and log viewing. Not a full file manager.

- Browse the filesystem on any agent-equipped device (within configurable root paths)
- Browse files inside a running Docker container (`docker exec` based)
- Open and edit text files in-browser (config files, `.env` files, etc.)
- Tail log files in real-time (streamed over WebSocket)
- No upload/download in v1 (nice to have later)

---

### 7. Identities & Roles

Multi-user support with role-based access control.

**Roles (built-in):**
- **Admin** — full access to everything
- **Operator** — can manage services and view devices, cannot change users or network config
- **Viewer** — read-only across all modules

Custom roles are out of scope for v1.

Users authenticate via username + password. OIDC/SSO integration (Authelia, Keycloak) is a v2 consideration.

---

## What's Out of Scope (v1)

- VM management (Proxmox, ESXi)
- Kubernetes / k3s support
- App store / one-click installs
- Mobile app
- Alerting / notifications
- Backup management
- Full file upload/download
- Custom RBAC roles

---

## Key Screens (for design reference)

1. **Dashboard** — all devices at a glance, status, resource summary, recent activity
2. **Device detail** — services, volumes, and metrics for a single device
3. **Services list** — all containers across all devices, filterable by device/status
4. **Service detail** — logs, env vars, volume mounts, port mappings
5. **Deploy service** — form to launch a new container (image, device, ports, volumes, env)
6. **Volumes** — all volumes across all devices, source type (local/LVM/NAS/cloud), what they're mounted to
7. **Reverse proxy** — list of proxy rules, add/edit rule form
8. **Network** — device mesh overview, DNS records
9. **Files** — device/container file browser with editor pane
10. **Settings → Users** — user list, invite, assign role

---

## Technical Notes (for context, not design)

- Manager + Agent model. Same codebase, flag determines mode.
- Agent exposes a gRPC API (mTLS); manager is the only caller.
- Manager stores state in SQLite (single-user) or Postgres (multi-user).
- Frontend is a SPA communicating with the manager's REST/WebSocket API.
- Reverse proxy module wraps Caddy; manager writes Caddyfile and signals reload.
- Mesh VPN is Tailscale-first (API-driven enrollment), with Nebula as a self-hosted alternative.
