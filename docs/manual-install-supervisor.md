# Spec: supervisor script for manual (custom) installs

Status: **draft / design — not yet implemented.** Jotted down for later.

## Motivation

Installed agents come in two flavors (the `mechanism` in `install.json`):

- **systemd** — a unit with `Restart=always`. Self-update is "swap the symlink + exit";
  systemd re-execs the symlink, now pointing at the new binary. Crash recovery comes
  free from the same `Restart=always`.
- **manual** — used on appliance OSes where we can't fabricate a vendor supervisor
  (TrueNAS read-only root / noexec mounts, etc.). Today `installManual()` just
  `setsid <launchCommand> &`'s the agent **once** and returns a start command for the
  operator to wire into their own init system (POSTINIT script, cron `@reboot`, …).

### The latent bug this fixes

`updateSelf()` ends with `process.exit(0)` on the assumption that *something* re-execs
the symlink. That holds for systemd, but the manual path has **no supervisor** — the
one-shot `setsid` spawn never restarts. So on a manual/custom install:

- a self-update downloads the new binary, repoints the symlink, then exits → **the
  agent is gone and never comes back** until the operator's init re-runs it (reboot);
- the same is true for any crash.

So manual installs silently lack the crash-recovery and self-update-restart that
systemd installs get.

## Proposal

On a manual install, write a small **self-restarting supervisor script** into the
install dir instead of doing a one-shot spawn. Hand the operator *that script* as the
thing to run from their init system. The script gives manual installs the same
`Restart=always` semantics systemd provides — so the existing "swap symlink + exit"
self-update flow Just Works on manual installs too, with no special-casing in
`updateSelf()`.

### The script (`<installDir>/sc-agent-run.sh`)

```sh
#!/bin/sh
# Self-restarting supervisor for the manually-installed sc-agent.
# Re-execs the stable symlink (sc-agent), so a self-update is just "agent exits".
set -u

BIN="<installDir>/sc-agent"          # stable symlink, repointed on update
CONFIG="<dataDir>/config.json"
PIDFILE="<dataDir>/agent.pid"
export TMPDIR="<dataDir>/tmp"        # exec-capable scratch (Bun native addons)

echo $$ > "$PIDFILE.supervisor"      # the loop's pid (for operator stop/management)

while true; do
    "$BIN" --agent --config "$CONFIG" &
    child=$!
    echo "$child" > "$PIDFILE"       # current agent pid
    wait "$child"
    # Agent exited (self-update, crash, or kill). Brief backoff, then re-exec the
    # symlink — which a self-update has already repointed at the new binary.
    sleep 5
done
```

Generate this from a template (like `agent/bootstrap.sh`) with the resolved paths
substituted, rather than hand-rolling the string, so install/data dir customization
flows through unchanged.

### PID file

Emit the **running agent's PID** to `<dataDir>/agent.pid` (the supervisor writes the
child's pid above; alternatively the agent writes its own pid on startup). Value:

- lets the update/stop path target the live process precisely (`kill <pid>`), so the
  supervisor's `wait` returns and the loop re-execs — this is the "self-update could
  just stop the process" path;
- gives the operator (and future tooling) a way to find/stop/restart the agent;
- guards against accidental double-starts.

Open question: who owns the pidfile — the supervisor (knows the child pid, survives
agent restarts) or the agent itself (knows its own pid, but the file goes stale
between restarts). Leaning supervisor-writes-child-pid, with the agent's own pid as a
secondary/sanity source. Decide at implementation.

### Two paths to "restart into the new version"

Both end with the supervisor re-execing the (now-repointed) symlink:

1. **Agent self-exits (current shape).** `updateSelf()` keeps its `process.exit(0)`;
   the supervisor loops. No new code in the update path — it just *works* once a
   supervisor exists. Simplest; preferred.
2. **External stop via pidfile.** Something reads `agent.pid` and signals the process.
   Useful for an operator-driven restart, but not required for self-update.

Recommend implementing (1) and treating the pidfile as the operator/management
affordance, not a dependency of the self-update flow.

## Changes required

- **`installManual()`** ([apps/server/src/agent/agent-cli.ts](../apps/server/src/agent/agent-cli.ts)):
  write `sc-agent-run.sh` (chmod 0755) into `paths.dir`; return a start command that
  launches the **script** (e.g. `setsid <installDir>/sc-agent-run.sh >/dev/null 2>&1 &`)
  instead of the raw `launchCommand`. Best-effort detached start now, as today.
- **`launchCommand()` / script template** — factor the `TMPDIR=… bin --agent --config …`
  invocation so the script and any direct command stay in sync.
- **PID file** — define `paths.pidFile = ${dataDir}/agent.pid`; write it from the
  supervisor (and/or agent startup).
- **`updateSelf()`** — no functional change needed for manual once the supervisor
  exists; consider a comment noting both mechanisms now rely on a re-execing supervisor.
- **Uninstall / cleanup** (when it exists) — remove the script + pidfile.
- **`isInstalled()`** — unchanged; still keys off the manifest for manual. The script's
  presence could be a secondary signal but isn't needed.

## Notes / risks

- The script is `sh`, not `bash` — keep it POSIX so it runs on minimal appliance shells.
- Backoff: fixed `sleep 5` mirrors systemd `RestartSec=5`. Could add capped backoff to
  avoid hot-looping if the binary is broken, but the versioned-binary + symlink rollback
  story (`KEEP_VERSIONS = 2`) already limits the blast radius — a bad update can be
  rolled back by repointing the symlink at the previous version.
- Operator's init system now supervises *the supervisor* (one entry), not the agent
  directly — cleaner than the current one-shot, and survives reboots if they wired it in.
- Still Linux-focused; manual mechanism is already gated to Linux in `installSelf()`.
