# RBAC & Host-User Mapping

Status: idea / design. Not yet scheduled. Mockup only — open questions remain.

## Problem

Server Central authenticates a user (sessions + first-run owner, see `auth.ts`)
but does **no authorization**. Every authenticated user gets the entire surface:
a root shell, root file read/write across `/`, arbitrary `exec`, docker/systemd
control — on every host. There's a coarse `Role` (`owner | admin | operator |
viewer`) on `UserInfo` that is never checked.

Two distinct things are tangled here and worth separating:

1. **Control-plane RBAC** — which *operations* a Server Central user may invoke
   (read metrics vs. write files vs. open a shell vs. enroll a node).
2. **Host identity** — *who* an action runs as on the managed host. Today
   everything runs as the agent's uid (root, since the agent is installed as a
   root service). A terminal session is a root shell regardless of who opened it,
   and there's no audit trail tying host actions back to a Server Central user.

The goal: gate operations by role, and map a Server Central user onto a concrete
host user so a terminal/exec runs with that user's privileges (and shows up as
them in host logs) — with an explicit "admin" mapping that grants passwordless
sudo.

## Part 1 — Control-plane RBAC

The operation registry (`CentralApiOperations` in `shared/src/index.ts`) is the
natural enforcement point. Each operation gets a required capability; the
dispatcher checks the caller's role against it before invoking the handler.

Coarse capability tiers (map onto the existing `Role`):

- `viewer` — read-only: metrics, lists (docker/systemd/network/processes), file
  *read*, log viewing.
- `operator` — `viewer` + lifecycle actions: docker/systemd start/stop/restart,
  file *write*/upload/rename/delete.
- `admin` — `operator` + host shell/exec, node enrollment/install/update, volume
  removal, image actions.
- `owner` — `admin` + user management; the first account, never deletable.

Mechanically, the cleanest fit given the planned spec-layer rework (richer per-op
metadata, possibly zod — see `known_issues.md`) is to attach a `minRole` to each
operation's schema entry and enforce it centrally in `index.ts` dispatch, the
same place `PUBLIC_COMMANDS` is checked today. Until that lands, a hand-maintained
`Map<Command, Role>` works.

Enforcement lives next to the existing auth gate: resolve `ctx.user.role`, reject
with 403 when below the operation's `minRole`. The `handle*` prefixing already
guarantees dispatch can only reach declared operations, so the capability table
is exhaustive by construction.

## Part 2 — Host-user mapping

Each Server Central user optionally maps to a host username **per host** (the
mapping is host-scoped because uids/accounts differ between machines):

```ts
interface HostUserMapping {
    userId: string;        // Server Central user
    hostId: string;        // machine id
    hostUser: string;      // e.g. "deploy", "jonas", "root"
    sudo: "none" | "nopasswd";  // "nopasswd" lays down a sudoers drop-in
}
```

When a user opens a terminal or issues an `exec` on a host, the agent runs it as
`hostUser` instead of unconditionally as the agent's uid:

- Terminal: spawn the PTY via `su - <hostUser>` (or `setuid` to the resolved uid)
  rather than the current `process.env.SHELL`. `runOpenShell` in `agent.ts` is the
  one place to change.
- `exec`: run under the mapped user. Note this interacts with the docker/systemd
  helpers, which currently assume they can talk to the root-owned docker socket /
  systemd — those may need to stay privileged or require the mapped user to be in
  the relevant group. **Open question.**

"admin" mapping = `sudo: "nopasswd"`: the agent writes a `/etc/sudoers.d/` drop-in
(`<hostUser> ALL=(ALL) NOPASSWD: ALL`) on install/mapping, validated with `visudo
-c` before install. This is the riskiest primitive in the feature and should be
explicit and audited.

### Account creation / group management (later)

Optionally, the agent can *create* the host account when a mapping is made
(`useradd`, set shell, add to groups like `docker`/`sudo`). Basic group membership
editing surfaces in the UI. This is additive on top of mapping and not needed for
the first cut — mapping to *existing* host users is the MVP.

## New state

- `users.json` gains the role enforcement (role already exists).
- New per-host mapping store, e.g. `host-users.json` (or folded into the agent
  state store), persisted with the existing atomic writer.

## Build order

1. **Control-plane RBAC** — capability table + central enforcement. Standalone,
   immediately valuable, no host changes.
2. **Host-user mapping (existing users)** — mapping store + run terminal/exec as
   the mapped user.
3. **Sudo-nopasswd "admin" mapping** — sudoers drop-in with `visudo -c` validation.
4. **Account/group management** — create host users, edit groups. Optional, last.

## Open questions

- Do docker/systemd operations run as the mapped user (requiring group membership)
  or stay privileged on the agent? Mixed model is likely (read as user, privileged
  actions gated by `admin`).
- How granular should capabilities be — the 4-tier role ladder above, or
  per-operation grants? Start coarse (roles), add overrides only if needed.
- Where does the host-user mapping live and how does it migrate with agent
  identity (same question the stack registry raises).
- Audit logging: tying host actions back to the Server Central user is half the
  point of mapping — worth a dedicated audit log, possibly the future task system.
