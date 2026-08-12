# App System — v1 (scoped)

Status: idea / design. Not yet scheduled. Supersedes the registry half of
[idea_stack_registry.md](idea_stack_registry.md) (an App's directory *is* a stack root —
see §6) and is the first real implementation of the placeholder sketched in `next.md`
under "App system" (2026-07-02 / 2026-07-13) and the `App` type stub already in
[`shared/src/index.ts`](../shared/src/index.ts) (today just OIDC relying-party
fields — see §7).

## Why v1 is scoped down from the original sketch

The 2026-07-13 sketch defined an App as a compose stack **+ reverse-proxy routes +
OIDC-provided auth roles + per-section reconcilers**. That's the right end state, but it
hard-depends on the Role-set redesign (`Role` is a single enum value per user today, not a
set — see the RBAC gap entry in `next.md`), which hasn't started. Waiting for that blocks
something useful for no reason.

v1 deliberately does **only** the part that doesn't depend on roles: an App is a directory
+ one compose stack + start/stop/restart/pull controls + a file browser over its volumes.
Routes, app-provided roles, and reconcilers stay exactly as designed in `next.md` and get
added as new optional sections on the same `App` record later, once the role-set redesign
lands. Nothing in this design should have to be reworked to add them — see §9.

---

## 1. Where it lives

Top-level "Apps" item in the sidebar (`Sidebar.tsx`), alongside Dashboard / Agents /
Proxy / Tasks / Settings — not nested under a host. An App *runs on* a host (it needs one
to hold its directory and run `docker compose`), but it is not *owned* by the host the way
Docker/Files/Services tabs are: the same App concept should read naturally whether you got
to it from the Apps list or, later, from a "this app's stack" backlink on the host's Docker
tab.

Concretely: `Route` gains `{ view: "apps" }` (list) and `{ view: "app"; appId: string;
tab: ... }` (detail), the same shape as the existing `{ view: "server"; ... }` pattern in
`routes.ts`.

## 2. One compose stack per App

Agreed default, and it's already the house rule: `next.md` states "compose file stays
source of truth for what runs — no SC-native service format." An App with multiple
*services* is just a compose file with multiple services (the normal case — e.g. Jellyfin
+ its Postgres). An App with multiple independently-deployable *stacks* is out of scope for
v1; if that need ever materializes, model it as multiple Apps rather than complicating the
1:1 relationship — a stack-of-stacks concept can be layered on top later without touching
this design, and there's no concrete case for it yet.

## 3. Directory layout

One directory per App, on the host it runs on:

```
<app-root>/
  sc-app.json         # SC's own metadata for this app (see §4)
  compose.yaml         # the compose file — source of truth for what runs
  volumes/
    <service>/
      <bind-mount-dir-or-file>...
```

Design choices, and why:

- **`compose.yaml` is a real file the operator can open, edit, and hand-edit outside SC.**
  No SC-native format wraps it. This matches the "compose stays source of truth" rule and
  means an App directory works even if SC is temporarily not looking at it.
- **`volumes/` holds every bind mount the compose file uses**, one subdirectory per
  service. Volumes view browses/edits inside here (reuses `FilesView` rooted at
  `<app-root>/volumes`, the same pattern `VolumeBrowser.tsx` already uses for the Docker
  tab's ad-hoc volume browsing). Named Docker volumes (not bind mounts) aren't
  file-browsable this way and are out of scope for the volumes view — the compose file can
  still declare them, SC just won't offer a file tree for them.
- **`sc-app.json` is the only SC-native artifact in the directory**, and it's small and
  optional-to-trust: if it's missing (a directory dropped in by hand, or an
  export/import that lost it), SC can still detect the directory as an app candidate from
  `compose.yaml` alone and regenerate it. This is what makes import painless (§5) and is
  the same trick `idea_stack_registry.md` uses for auto-learning roots from the
  `config_files` label — except here SC owns the directory, so it doesn't need the label
  at all.
- **Everything an App needs is inside its own directory, nothing outside it.** That's the
  entire mechanism import/export needs (§5) — no separate manifest to keep in sync, no
  scattered state.

One configured base directory per host (e.g. `/opt/sc-apps`) is where SC creates new App
directories by default; the operator can point at an existing directory anywhere on the
host instead (reuses the existing `listDir`-backed directory picker, `DirectoryPicker.tsx`).

## 4. Data model

Extends the existing `App` type in `shared/src/index.ts` rather than introducing a second
concept with an overlapping name (see §7 for why that type already exists and what's in it
today).

```ts
export interface App {
    id: string;
    name: string;
    hostId: string;
    dir: string;              // absolute path on hostId; everything below is relative to this
    composeFile: string;      // relative path within dir, default "compose.yaml"
    createdAt: number;
    // --- existing OIDC-client fields, unchanged, now optional --- (§7)
    redirectUris?: string[];
}
```

`sc-app.json` on the host mirrors the subset of this that's meaningful without the control
plane (`id`, `name`, `composeFile`, `createdAt`) — the control plane's copy is the live
one; the on-disk copy exists so a directory is self-describing when moved or imported
somewhere else.

```ts
interface AppManifest {   // sc-app.json
    id: string;
    name: string;
    composeFile: string;
    createdAt: number;
}
```

`AppStore` on the control plane (`apps/server/src/apps.ts`, new) mirrors `Fleet`'s
load-on-start / persist-on-change pattern, keyed by `App.id`, persisted to
`.sc-data/apps.json` — this *is* the central directory of app locations the write-up
mentions, one flat list across all hosts (no per-host registry to merge; a host going
offline just means its apps show as unreachable, same as any other host-scoped view today).

## 5. Import / export

Because an App directory is fully self-contained (§3), export is just "hand the operator a
tarball of the directory" (`tar -C <app-root> -czf <name>.tar.gz .` via a task, or a plain
download if it's small — TBD by size, not a design blocker) and import is "point SC at a
directory containing a `compose.yaml`, on any registered host":

- If `sc-app.json` is present, adopt its `id`/`name` (rewritten with a fresh `id` on import
  to avoid collisions across installations — two SC installs must never share an app id).
- If it's absent, this is exactly the stack-registry "on-disk, no label" case: parse
  `compose.yaml` for a predicted project name, ask the operator to confirm/name it, then
  write a fresh `sc-app.json`.

Untarring into a directory under a host and running "import from directory" is the whole
flow — no separate export format to design, maintain, or version.

## 6. Relationship to the stack registry idea

`idea_stack_registry.md` solves "where are the compose files SC doesn't currently see
running containers for" for stacks that predate SC or were deployed by hand. Its `StackRoot`
(`{ hostId, dir, name?, addedBy }`) is, structurally, exactly an App directory minus
`sc-app.json`.

Recommendation: don't build both. An App directory *is* a stack root once it has a
`compose.yaml`; the App system's directory convention absorbs the registry's job. What
`idea_stack_registry.md` still contributes and this doc doesn't replace:

- §2 (three-source detection merge: running / on-disk / reconcile) — still needed so an
  App whose containers are fully down (`docker compose down`) still shows up and is
  actionable, not just apps that happen to be running right now.
- §3's `DockerStack`-shaped status/service breakdown (`running` / `partial` / `stopped` /
  `down` / `orphaned`) — useful vocabulary for an App's status, adopt as-is.
- The "orphaned" case (containers running, no known compose source) stays meaningful for
  stacks that were never adopted as an App — that's not a bug in this design, it's the
  legitimate "not everything running on a host is an App" case, and the existing
  container-labels-only `dockerStacks()` view keeps serving it.

What the registry doc's §1 (bounded `find` scan of a configured base to *discover*
unregistered compose files) becomes here: optional and lower-priority, since v1 apps are
always explicitly created or imported through SC, not discovered by scanning. Worth doing
later as a "hey, I found these compose files under /opt that aren't registered as Apps, add
them?" convenience, not a v1 requirement.

## 7. Relationship to the existing `App` = OIDC-client placeholder

`shared/src/index.ts:512` already has an `App` interface — created 2026-07-02 specifically
as a placeholder for this concept ("renamed the SSO-clients concept to Apps end to end...
as a placeholder ahead of the real design — today an App is still just an OIDC
relying-party registration"). That's why §4 extends it rather than picking a different
name: the name was chosen in anticipation of exactly this.

Concretely, the existing `redirectUris` field becomes optional and only meaningful for an
App that later grows an OIDC section (deferred, needs the role-set redesign per the
original sketch — see the top of this doc). An App created by v1 with no OIDC involvement
simply leaves it unset. No migration is needed for the (currently placeholder-only) data
that exists today; it just gains new required fields (`hostId`, `dir`, `composeFile`).

## 8. Actions & the task system

Start/stop/restart already fit the existing `docker_stack_action` task kind
(`shared/src/tasks.ts`, `apps/server/src/tasks/types.ts`) once it's driven by
`composeFile` instead of only by a running project's containers — extend
`dockerStackAction()` (`apps/server/src/docker.ts`) to accept a compose-file + project
pair the way `idea_stack_registry.md` §3 describes (`docker compose -f <composePath> -p
<project> <verb>`), so it works on a fully-down App too. Same path-safety note as that doc:
`composePath` needs proper quoting/escaping or a `cwd`+relative-filename approach — it's
host-controlled data, not a validated identifier like `SAFE_ID_RE` covers today.

**`up`/`pull` are the case that actually needs the task system's envelope *and* a transport
fix, not just the envelope.** Checked against the current code: `HostAgent.exec()`
(`apps/server/src/host-agent.ts`) has a hard 30s `REQUEST_TIMEOUT_MS` with no override, and
the existing `docker_image_pull` task kind already lives with this limitation today —
`dockerImagePull()` (`apps/server/src/docker.ts`) calls `onLog` exactly **once**, after
`exec` resolves, not as output streams in. A slow pull either finishes within 30s or the
whole task fails with a timeout and no partial log — the task system's run-history/log
envelope is already wired up, it's just fed by a call that can't stream and can't run long.
`docker compose pull`/`up` on a multi-service app makes this worse, not better.

So: build the streaming-exec primitive `idea_stack_registry.md` §4 already flagged as a
prerequisite, once, as shared infra — it fixes `docker_image_pull`'s existing log gap for
free and unblocks a new `docker_compose_action` task kind (`up` / `pull`, in addition to
`docker_stack_action`'s existing `start`/`stop`/`restart`/`down`) at the same time:

- New `execStreamRequest` / `execStreamChunk` / `execStreamEnd` node-protocol messages, no
  fixed timeout, chunks forwarded live to `ctx.log` as they arrive (the task system already
  broadcasts `taskLog` per line — this just gives it something to feed on beyond
  end-of-command).
- Alternative considered: reuse `openShell`'s PTY path (lowest new surface, terminal-formatted
  output). Rejected as the primary mechanism for this because task-kind handlers need a
  structured exit code and a clean "done" signal, which a PTY session doesn't give for free —
  but keep it in mind as a fallback if the new protocol messages turn out to be more work
  than expected.

Adding `docker_compose_action` is the normal three-spot addition the task system doc
describes (`TaskSpec` variant, `TaskResult` variant, handler in `taskHandlers`) — no change
to the task system itself, it's designed for exactly this.

## 9. Frontend

- **Apps list** (`AppsView.tsx`, new) — table of all Apps across all hosts: name, host,
  status (via §6's status vocabulary), quick start/stop. Mirrors `TasksView.tsx`'s
  "everything, everywhere, filterable" shape rather than `Dashboard.tsx`'s per-host cards.
- **App detail** (`AppView.tsx`, new, tabbed like `ServerOverview`'s host tabs):
  - *Overview* — status, host, directory path, quick actions.
  - *Compose* — the compose file, editable (`CodeEditor.tsx`/`MonacoPane.tsx`, same
    component `DockerStacks.tsx` would use for the optional editor `idea_stack_registry.md`
    §5 deferred — this is where it lands first).
  - *Volumes* — `FilesView` rooted at `<app-root>/volumes`, unchanged component, new root.
  - *Controls* — start/stop/restart/pull, via `runTaskAndWait()` same as every other task-backed
    control in the app today (`ServicesView`, `DockerStacks`).
  - *Logs* — container logs, reuses `LogViewer.tsx`/`ansi.ts` already built for the Docker tab.
- **Create/import** — a modal, same shape as `AddNodeModal.tsx`: "Create new" (name + host +
  directory, scaffolds `compose.yaml` empty or from a starter template — templates are a
  nice-to-have, not required for v1) vs. "Import existing" (host + directory picker, §5).

No new visual language — every piece here is an existing component pointed at a new root
or a new task kind, which is why v1 is achievable without the routes/roles machinery.

## 10. Build order

1. `App` type extension + `AppStore` (§4) — nothing else has anywhere to live without it.
2. Directory scaffolding: create/import (§3, §5) — CRUD before actions.
3. `docker_stack_action` extended to compose-file+project targeting, App detail's Overview
   + Controls tabs wired to it (start/stop/restart/down work immediately, no streaming-exec
   dependency).
4. Streaming exec (§8) — prerequisite for `up`/`pull` only; everything above ships without it.
5. `docker_compose_action` task kind (`up`/`pull`) once streaming exec lands.
6. Compose editor + Volumes tab (§9) — additive, no dependency on 4/5.
7. Status merge from `idea_stack_registry.md` §2 (running/disk/reconcile) — makes a fully
   `down` App still show correctly; can ship after 3 with a temporary "unknown until
   started" status if sequencing pressure demands it.

## 11. Open questions

- Export format/size threshold (inline download vs. a task that writes a tarball
  server-side and hands back a path) — not a design blocker, decide when building §5.
- Starter templates for "create new" (a canned Jellyfin/Postgres/etc. `compose.yaml` to
  start from) — nice-to-have, out of scope for the build order above.
- Whether `AppsView`'s table should fold in the "orphaned" running-but-unregistered stacks
  from §6 as a "adopt as App" prompt, or leave that entirely to the Docker tab. Leaning
  toward Docker tab only for v1 — keeps the Apps list to "things SC actually manages."
- Per-volume backup classification (`idea_backup_secrets.md`'s `declared`/`captured`/
  `regenerable`/`external`/`tracked`) hangs off this directory structure once that design is
  picked back up — nothing here should need to change to support it, `volumes/<service>/`
  is exactly the granularity that doc's classification wants, but not designing it in now.
</content>
