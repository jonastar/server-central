**Prototype stage**

This project is in the prototyping stage, it's not meant to be used by end users and is very experimental.

# Server-central (working title)

Server central is a project of mine to create a all in one server/Cluster management tool targetting home servers/homelabs/smaller businesses.

There's a lot of similar services and tools out there, but i'm not satisfied with what i've tried so far (granted i haven't tried everything) so here is my attempt at seeing how far i can making my own.

<img width="3062" height="1203" alt="bilde" src="https://github.com/user-attachments/assets/3b0e905f-a2fe-47b5-b920-23b6f83164e5" />

# Features

- Multi server management (implemented)
  - This is a core feature
  - Nodes install a node agent that self installs by downloading the agent from the control plane and installing a systemd service on linux
  - Node - control plane communication happens over https through custom CA and self signed cert, no domain setup required with lets encrypt or something, yet secure and encrypted.
    - (node install command you copy has the pubkey)
- System management
  - Networking (WIP)
  - Wireguard overlay network (Unimplemented)
  - Users (Unimplemented)
    - Mapping server central users to system users
- Users (unimplemented)
  - RBAC permission based system
  - SSO provider, with scoped access
- File manager (basic implementation)
  - Text editor (implemented, monaco)
  - Basic file management (rename, move, delete, upload)
  - Download (unimplemented)
- Docker management (WIP)
  - Currently only has basic container, volume, networks, stacks views, with basic start/stop controls and logs
  - Docker compose management to be implemented
- Systemd management (WIP)
  - Services view with basic start/stop controls
  - Logs
- Reverse Proxy integration (unimplemented)

As you can see im still a bit away from just the prototype being done, there's still some concepts and things im gonna have to figure out.

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
