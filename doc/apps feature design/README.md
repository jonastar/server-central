# Handoff: Server Central — App system v1 (Apps list + App detail + create/import)

## Overview

Adds a top-level **Apps** section to Server Central. An App = a directory on a host containing
`sc-app.json` + `compose.yaml` + `volumes/`, exposed in the UI as: a list of all Apps across all
hosts, a tabbed detail view (Overview / Compose / Volumes / Controls / Logs), and create/import
modals. Scope matches the "App System — v1 (scoped)" design doc: no routes, no OIDC roles, no
reconcilers.

**Design decisions settled with the designer:**
- Apps list = **cards grouped by server** (screen `2a`).
- App detail = **tabbed**, matching the existing `ServerOverview` + `sub-tabs` pattern (screen `1d`).
- Import = **stepped** modal; create = **single** modal.

## About the Design Files

`Apps Feature.dc.html` and `ScSidebar.dc.html` in this bundle are **design references written as
streaming HTML prototypes** — they show intended look, copy, and structure. They are not production
code and should not be copied into the app. Implement the screens as normal React components in
`apps/web/src`, using the repo's existing CSS-module + shared-token conventions
(`styles/global.css`, `styles/shared.module.css`), not the inline styles used in the prototype.

The prototype's sidebar is a recreation of the real `Sidebar.tsx` purely for context; the only real
change to the sidebar is **one new nav item, "Apps", between Agents and Proxy**.

## Fidelity

**High-fidelity.** Colors, type sizes, paddings, radii, and copy are final and taken from the
repo's own tokens/classes. Recreate 1:1 by reusing the existing classes below rather than writing
new CSS — nearly every element in these screens already exists in `shared.module.css`.

## Existing code to reuse (do not reinvent)

| Need | Use |
| --- | --- |
| View shell, header, panels | `shared.view`, `shared["view-header"]`, `shared.panel`, `shared["panel-head"]` |
| Tables | `shared["data-table"]`, `shared["row-status-*"]`, `shared["row-actions-always"]`, `shared["row-busy"]` |
| Status badges | `shared.badge` + `badge-ok` / `badge-warn` / `badge-err` / `badge-muted` |
| Status dot | `StatusDot` from `components/ui.tsx` |
| Info chips | `shared["info-chip"]`, `-label`, `-value` (see `ServerOverview.tsx`'s local `InfoChip`) |
| Tabs | `shared["sub-tabs"]`, `shared["sub-tab"]`, `.active` (as `DockerView`/`ContainerDetail` use them) |
| Status filter pills | `components/StatusFilter.tsx` + `StatusFilter.module.css` |
| Modals | `Modal` from `components/ui.tsx` (`width` prop), `shared["form-grid"]`, `shared["modal-actions"]` |
| Directory picking | `components/DirectoryPicker.tsx` |
| File browsing | `components/FilesView.tsx` (new root), `FilesView.module.css` split/editor panes |
| Compose editing | `components/CodeEditor.tsx` / `MonacoPane.tsx` |
| Logs | `components/LogViewer.tsx` + `ansi.ts`; `shared["logs-pre"]`, `shared["log-select"]` |
| Task actions | `runTaskAndWait()` from `api.ts`; `TaskModal`/`TaskWidget` for in-flight runs |
| Empty/error | `EmptyState`, `ErrorBanner`, `DetailPair` from `components/ui.tsx` |

## Screens / Views

### 1. Apps list — `AppsView.tsx` (new) — design ref `2a`

**Purpose:** see every App on every host and take the one-click action (restart/stop/open).

**Layout:** standard `shared.view` (padding 18px 22px, column, gap 14px).
1. Header (`view-header`): `<h1>Apps</h1>` (18px, `margin-right:auto`), then status filter pills,
   a 220–240px filter input, `Import existing…` (btn), `New App` (btn-primary). Give the buttons
   `white-space: nowrap`.
2. Scroll region (`flex:1; min-height:0; overflow:auto`), column, gap 18px — **one group per host**.
3. Per host group:
   - Group header row: `StatusDot` (agent state) · host name (13px, 700, uppercase, letter-spacing
     .04em) · `{ip} · {os}` in `--muted` 12px · right-aligned `"{n} apps · {n} running"` 12px muted
     · `New App here` (btn-sm). Bottom border `1px solid var(--border)`, 6px padding-bottom.
   - Card grid: `repeat(auto-fill, minmax(268px, 1fr))`, gap 12px.
4. Card (`--panel` bg, 1px `--border`, radius `--radius` 8px, padding 12px 14px, column, gap 10px):
   - Row 1: app name (14px, 600, `--accent`, acts as the link into detail) + status badge right.
   - Row 2: `"{up}/{total} services up"` (12px muted); directory path in mono 11.5px muted, single
     line, ellipsis.
   - Row 3: service bar — one 6px-tall, 3px-radius flex segment per service, `--ok` if up else
     `--border`; right of it the last action `"restart · 2d ago"` (11.5px muted, nowrap).
   - Row 4: `Restart`, `Stop` (btn + btn-sm), and `Open` pushed right with `margin-left:auto`.

**Status vocabulary** (from `idea_stack_registry.md` §3, adopt as-is) and its badge tone:
`running`→ok, `partial`→warn, `stopped`→muted, `down`→muted, `orphaned`→err. Filter pills in the
prototype: `All 15` and `Needs attention 6` (everything not `running`); the full five-way pill set
is also drawn in design ref `1a` if you prefer it.

Orphaned running-but-unregistered stacks stay on the Docker tab for v1 (open question in the doc);
the prototype hides them behind a flag.

### 2. App detail — `AppView.tsx` (new), tabbed — design refs `1d`–`1h`

Header: `Apps /` breadcrumb in muted, `<h1>{app.name}</h1>`, status badge (`margin-right:auto`),
then `Restart` / `Stop` / `Pull` buttons. Below it the `sub-tabs` strip:
**Overview · Compose · Volumes · Controls · Logs** (active tab = `--accent`, 2px accent
bottom-border, 600). Adding a tab later is one more `sub-tab` + one more section — keep that shape.

**Overview (`1d`)**
- `info-chips` row: Host, Directory (mono), Compose file (mono), Project (mono), Created, Manifest
  (`sc-app.json present` / `missing`).
- Two-column grid `minmax(340px,1.6fr) minmax(320px,1fr)`, gap 14px, `align-items:start`:
  - Left panel "SERVICES (n)" — `data-table`: Service (600) · Image (mono 12px muted) · State
    (badge, e.g. `up 6d`) · Ports (mono, `—` when none).
  - Right column: panel "RECENT TASK RUNS" — rows of `badge · mono task kind · action`, right-aligned
    `"{when} · {duration}"`; panel "VOLUMES" — `120px 1fr` grid rows per `volumes/<service>/`, plus a
    muted row for bind mounts outside the app dir.

**Compose (`1e`)**
- Full-height panel using the `FilesView` editor shell: toolbar (`--panel-2`, bottom border) with
  absolute path in mono, an `unsaved changes` warn badge, right side `yaml · n lines`, then
  `Revert`, `Save`, `Save & up` (primary).
- Body: `CodeEditor`/`MonacoPane` on the compose file (yaml), 12.5px mono, line-height 1.7.
- Footer strip (muted 12px): "Saving writes the file on **{host}** only — it does not restart
  anything. Use **Save & up** to apply."

**Volumes (`1f`)**
- Breadcrumbs: static `<app-dir>/` prefix in mono muted, then crumbs `volumes / <service> / …`
  (`shared.crumb`). Right side: muted note "bind mounts only — named volumes aren't browsable",
  `Upload`, `New folder`.
- `FilesView` rooted at `<app-root>/volumes` — reuse the component unchanged, only the root differs
  (same as `VolumeBrowser.tsx` does for Docker). Split panes 38% list / rest editor.

**Controls (`1g`)**
- Panel "STACK ACTIONS": grid `repeat(auto-fit, minmax(320px,1fr))`, gap 10px. One bordered row per
  action: title (600) + subtitle naming the task kind, and a `Run` button.
  - `Start` — `docker_stack_action · start`
  - `Restart` — `docker_stack_action · restart`
  - `Stop` — "containers stay defined"
  - `Pull & up` — `docker_compose_action · streams live` (primary button)
  - `Down` — danger styling (`btn-danger`, err-tinted border), subtitle "removes containers ·
    volumes/ untouched"; confirm before running.
- Panel "RUN IN PROGRESS": accent-tinted `running · 0:12` badge + dark log pre (`#1d2026` bg,
  `#d6d9de` text, 12px mono) streaming `ctx.log` lines live.

**Logs (`1h`)**
- Toolbar: service select (`All services`), tail-size select, search input, match counter, `Wrap`
  and `Follow` checkboxes, right-aligned line count — i.e. `LogViewer`'s existing controls.
- `LogViewer` body, per-service prefixed lines.

### 3. New App — single modal (`1k`)

`Modal title="New App" width={560}`. Fields: Name; row of Host (select) + Base directory (input +
`Browse…` → `DirectoryPicker`); a `--bg` tinted preview block "WILL CREATE" showing
`/<base>/<name>/ · sc-app.json · compose.yaml · volumes/` in mono; Compose file choice as three
buttons (`Empty` selected/primary, `From template…`, `Paste YAML`). Actions: `Cancel`,
`Create App` (primary), and a muted hint "Nothing is started until you run **Up**."
Templates are optional/nice-to-have per the doc.

### 4. Import existing — stepped modal (`1l`)

`Modal title="Import existing App" width={620}` with a step strip below the header
(`--panel-2` bg, bottom border): ✓ Location — **2 Detected** — 3 Confirm (18px circles: done =
ok-tinted ✓, current = accent filled, upcoming = `--bg`/muted).

- Step 1 (Location): host select + directory picker.
- Step 2 (Detected), drawn in the ref:
  - `host : path` in mono, right-aligned `Change` button.
  - ok-tinted panel: `compose.yaml found` badge + `"4 services · 3 bind mounts · 1 named volume"` +
    the service names in mono.
  - warn-tinted panel when `sc-app.json` is absent: "A fresh one will be written with a new id.
    Project name predicted from the directory — confirm below." (On import, always mint a fresh
    `id`, even when a manifest exists.)
  - neutral panel listing bind mounts pointing outside the directory, mono `src → dest`, with
    "They stay where they are — the Volumes tab only browses **volumes/**."
  - App name input (prefilled from prediction).
  - `Back` / `Continue` (primary).
- Step 3 (Confirm): summary + `Import`.

### 5. Sidebar — `Sidebar.tsx` (edit)

Add one `nav-item` **Apps** after Agents, before Proxy, active when `route.view === "apps"` or
`"app"`. No other sidebar change; Apps is top-level, not nested under a host.

## Interactions & Behavior

- Card/row name click → `{ view: "app", appId, tab: "overview" }`. Tab clicks patch `tab` only.
  `Route` gains `{ view: "apps" }` and `{ view: "app"; appId: string; tab: … }`, same shape as the
  existing `{ view: "server"; … }` (`routes.ts`, hash routing via `useHashRoute`).
- All actions go through `runTaskAndWait()` exactly as `ServicesView`/`DockerStacks` do; the row or
  card gets `row-busy`/disabled buttons while its task is in flight, then the list reloads.
- `stop` / `down` require a `confirm()` (destructive-ish but reversible; no type-to-confirm needed).
- List polls like `DockerStacks` (`REFRESH_MS = 10_000`); header shows "refreshed Ns ago".
- Unreachable host: group header dot goes offline-grey, its cards show last-known status and
  actions are disabled — mirror how host-scoped views behave today.
- `up`/`pull` runs stream into the Controls panel and the existing `TaskModal`; a run started from
  the list opens `TaskModal` (as `TasksView` does for in-flight runs).
- Errors: `ErrorBanner` at the top of the view/panel, never a toast.
- Empty state: `EmptyState` with "No apps yet." + the two create/import buttons.
- Responsive: card grid is already `auto-fill`; under 768px the existing `.view` padding drop and
  `files-split` column stacking apply.

## State Management

Frontend: `AppsView` — `apps` (from control plane), `statusFilter`, `text filter`, `busyId`,
`error`. `AppView` — `app`, `tab`, `services`, `taskRuns`, `composeText` + `dirty`, `logs`,
`busy`. Live updates arrive over the existing events socket (`connection.ts`, `useConnection`);
task progress via `taskUpdate`/`taskLog`.

Backend (per the design doc, for context):
- Extend `App` in `shared/src/index.ts` with `hostId`, `dir`, `composeFile`, `createdAt`; existing
  `redirectUris` becomes optional.
- `AppStore` in `apps/server/src/features/apps/apps.ts` (new), `Fleet`-style load-on-start / persist-on-change,
  keyed by `App.id`, persisted to `.sc-data/apps.json`.
- `sc-app.json` on disk mirrors `{ id, name, composeFile, createdAt }`; regenerate from
  `compose.yaml` when missing.
- Extend `dockerStackAction()` to target compose-file + project (`docker compose -f <path> -p
  <project> <verb>`) so a fully-down App is still actionable; quote/escape the path or use
  `cwd` + relative filename (host-controlled data).
- `up`/`pull` need the streaming-exec primitive first (`execStreamRequest`/`Chunk`/`End`, no fixed
  30s `REQUEST_TIMEOUT_MS`), then a new `docker_compose_action` task kind. Everything except
  `up`/`pull` ships without it.

Build order from the doc: data model → create/import → stack actions + Overview/Controls →
streaming exec → `docker_compose_action` → compose editor + volumes → status merge.

## Design Tokens (all already in `styles/global.css`)

`--bg #eef0f3` · `--panel #ffffff` · `--panel-2 #f7f8fa` · `--border #dfe2e8` · `--text #23272e` ·
`--muted #6b7280` · `--accent #3b6ef6` (hover `#2f5ce0`) · `--accent-soft #e9efff` · `--ok #22a06b` ·
`--warn #d99a0b` · `--err #d64545` · `--radius 8px`. Offline dot `#9aa1ab`. Log surface `#1d2026`
on `#d6d9de`.

Type: `13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif`; h1 18px; panel h3 13px 600
uppercase .04em muted; table th 11px uppercase .04em muted; badge 11px 600; info-chip label 10px
uppercase .05em / value 12.5px 600; mono `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
at 12–12.5px.

Spacing: view padding 18px 22px; view gap 14px; panel padding 12px 14px; card padding 12px 14px,
gap 10px; grid gaps 12–14px. Table cells: the prototype uses a roomier **9px 10px** (`td`) /
6px 10px (`th`) instead of `data-table`'s current 5px 8px / 4px 8px — apply that as an Apps-local
override, or bump the shared table if you want it everywhere.

Radii: 8px panels/cards, 6px inputs/buttons, 10px badges/modals, 999px filter pills.
Shadow: modal `0 12px 40px rgba(20,30,60,0.25)`.

## Assets

None. No new icons or images; the only glyphs are the existing sidebar `⬡`, the modal `✕`, and the
step-strip `✓`.

## Files

- `Apps Feature.dc.html` — all screens. Turn 2 (`2a`) is the settled Apps list; turn 1 holds
  `1a`–`1l`: list alternatives (`1a` flat table, `1b` grouped rows, `1c` flat cards), detail tabs
  (`1d` Overview, `1e` Compose, `1f` Volumes, `1g` Controls, `1h` Logs), detail-structure
  alternatives (`1i` single scroll, `1j` split pane), and modals (`1k` create, `1l` import).
- `ScSidebar.dc.html` — sidebar recreation used by every frame (context only).
- Repo files the design was built from are listed in `github.md` at the project root.
