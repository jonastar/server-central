**Alpha stage**

This project is in a very early stage, I would not rely on it for anythign mission critical (or rely on it at all).

# Server-central (working title)

Server central is a project of mine to create a all in one server/Cluster management tool targetting home servers/homelabs/smaller businesses.

Pictures says more than words, so have some screnshots, then ill go into more details below:

<img width="1640" height="657" alt="Screenshot 2026-08-25 232214" src="https://github.com/user-attachments/assets/37237675-a460-40b2-aa81-980e029cd133" />

<img width="1612" height="957" alt="Screenshot 2026-08-25 232301" src="https://github.com/user-attachments/assets/dee4dade-7c24-4d3f-8269-1e8740d388bb" />

<img width="2872" height="1007" alt="Screenshot 2026-08-25 231537" src="https://github.com/user-attachments/assets/6ab38bc2-b72b-4737-b33c-08e07de3bd89" />


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
