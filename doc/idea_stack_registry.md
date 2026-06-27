# Stack Registry & Full Compose Management

Status: idea / design. Not yet scheduled.

## Problem

Today a "stack" in Server Central is derived purely from running containers. [`dockerStacks()`](../apps/server/src/docker.ts) runs `docker ps -a`, reads the `com.docker.compose.project` label off each container, and groups by it. A stack is therefore only visible if it has **at least one container** (running or stopped). The `com.docker.compose.project.config_files` label gives us the absolute path of the compose file that created those containers, and we already store it on [`DockerStack.configFiles`](../shared/src/index.ts) — but we never read or use it.

This has two consequences:

1. We only ever know the *containers* of a stack, never its *intended* service set. If a compose file defines four services and one is down, we show "3 containers" with no hint that a fourth was ever supposed to exist.
2. A stack that has been fully `docker compose down` (zero containers) is **invisible**. Docker keeps no record that the project ever existed, so there is nothing for `docker ps` to report.

The goal of this work is **full compose management**: detect stacks both from running containers and from compose files on disk, show defined-vs-present services, and drive `up` / `down` / `pull` / `restart` from the compose file itself — not just per-container actions.

## Why this is hard

Docker exposes no "list compose projects" API. The only durable link between a running project and its source file is the `config_files` label, and that label disappears the moment the last container is removed. So:

- For a stack with containers, we already know exactly where its compose file is (the label) — no searching needed.
- For a down stack, the evidence is gone. The control plane has to remember where compose files live on its own. **That memory is the new piece of state this design introduces: the stack registry.**

There is also an inherent matching ambiguity. A compose file on disk only *predicts* its project name (compose's rule: the `name:` field if present, else the lowercased/sanitized basename of the file's directory). The operator can override it with `-p` or `COMPOSE_PROJECT_NAME`, so the predicted name may not match the running project. The `config_files` label is the only *certain* link between a file and a running project; predicted-name matching is best-effort and must be treated as such.

## Host primitives available

The agent ([`HostAgent`](../apps/server/src/host-agent.ts)) already gives the control plane everything compose needs on a host:

- `exec(command)` — one-shot command, request/response.
- `readFile(path)` / `writeFile(path, content)` — read and edit compose files.
- `listDir(path)` — browse the host filesystem (already backs [`FilesView`](../apps/web/src/components/FilesView.tsx)).
- `openShell(...)` + streaming `shellData` — interactive PTY with live output.

One hard constraint: `exec` has a **30s timeout** (`REQUEST_TIMEOUT_MS` in [`host-agent.ts`](../apps/server/src/host-agent.ts)) and returns only a final result. `docker compose pull` and `docker compose up` routinely run for minutes and stream progress — they will time out and produce no live output over `exec`. See "Streaming exec" below.

---

## Design

### 1. The stack registry (new state)

A persisted, per-host list of **stack roots** — directories on a host known to contain a compose file:

```ts
interface StackRoot {
    hostId: string;
    dir: string;          // absolute dir on the host
    name?: string;        // optional explicit project name override
    addedBy: "user" | "auto" | "configured";
}
```

Persisted alongside existing agent state (the same store that holds agent identity/persistence today). This is the one genuinely new bit of durable state — without it, "deploy a stack that is currently down" has no anchor to deploy from.

Roots are populated three ways:

1. **User-added** — the operator picks a folder containing a compose file in the UI. Reuses the existing `listDir`-backed file browser.
2. **Auto-learned** — for every running stack, take its `config_files` label, strip to the parent directory, and register it as a root. Self-populating for anything that has run at least once.
3. **Configured base** — optional configured base dir(s) (e.g. `/opt/stacks`) scanned with a bounded `find` (see below).

### 2. Detection = merge of three sources

`dockerStacks()` changes from a pure `docker ps` derivation into a merge keyed by project name:

1. **Running/created** — current `docker ps -a` label grouping. Source of truth for what is deployed.
2. **On-disk** — for each registered root, `readFile` the compose file, parse YAML, derive the predicted project name and the declared service list.
3. **Reconcile** — match disk → running. Prefer the `config_files` label as the certain link; fall back to predicted-name matching, flagged as uncertain.

Bounded discovery scan for configured bases (never a bare `find /`):

```
find <root> -maxdepth 3 -type f \( -name 'docker-compose.y*ml' -o -name 'compose.y*ml' \)
```

Each merged stack gains a status and a service breakdown:

```ts
interface DockerStack {
    project: string;
    containers: number;
    running: number;
    configFiles: string;
    states: string[];
    // --- new ---
    source: "running" | "disk" | "both";
    status: "running" | "partial" | "stopped" | "down" | "orphaned";
    composePath?: string;        // resolved compose file path, if known
    services?: {
        name: string;            // service from the compose file
        defined: boolean;        // present in compose file
        present: boolean;        // has a container right now
        state?: string;          // container state, if present
    }[];
}
```

Status meanings:

- `running` — all defined services up.
- `partial` — some services up, some down.
- `stopped` — containers exist but none running.
- `down` — defined on disk, zero containers.
- `orphaned` — running, but no compose file found (source `running` only).

### 3. Actions move to `docker compose -f`

The current [`dockerStackAction()`](../apps/server/src/docker.ts) operates on container IDs, which is impossible for a down stack — there are no containers to act on. A parallel compose-based path is needed:

```
docker compose -f <composePath> -p <project> up -d
docker compose -f <composePath> -p <project> down
docker compose -f <composePath> -p <project> pull
docker compose -f <composePath> -p <project> stop | restart
```

Two concerns:

- **Path safety.** `composePath` comes from labels / the registry — host-controlled paths that may contain spaces and shell metacharacters. The existing `SAFE_ID_RE` validates project names but does **not** cover file paths. Either quote/escape the `-f` argument properly or run with `cwd` set to the root dir and a relative file name. This is the primary injection surface in this feature.
- **Project name override.** Pass `-p <project>` explicitly so deploy targets the same project the rest of the UI tracks, rather than letting compose re-derive it from the dir.

### 4. Streaming exec (prerequisite for actions)

`pull` and `up` exceed the 30s `exec` timeout and stream progress that operators expect to watch. Resolve before building actions, one of:

- **Reuse the PTY path** — run the compose command through `openShell`, which already streams `shellData` to the client. Lowest new surface; output is terminal-formatted.
- **Add a streaming-exec control message** — new `execStreamRequest` / `execStreamChunk` / `execStreamEnd` messages in [`node-protocol.ts`](../shared/src/node-protocol.ts) with no fixed timeout. Cleaner data model, more protocol work.

Recommendation: reuse the PTY first to unblock, add streaming exec later if structured output is needed.

### 5. Compose editing (optional, additive)

Because `writeFile` exists, the compose file can be edited in-browser and redeployed — a lightweight Portainer-style stack editor. Out of scope for the first cut; layers cleanly on top of 1–4.

---

## Files touched

- [`shared/src/index.ts`](../shared/src/index.ts) — extend `DockerStack` (`source`, `status`, `services`, `composePath`); add `StackRoot` and registry request/response shapes; widen `StackAction` for compose verbs (`up`, `pull`).
- [`shared/src/node-protocol.ts`](../shared/src/node-protocol.ts) — streaming-exec messages, if that route is chosen.
- New registry state + CRUD handlers in [`apps/server/src/handler.ts`](../apps/server/src/handler.ts).
- [`apps/server/src/docker.ts`](../apps/server/src/docker.ts) — YAML parse + three-source merge in `dockerStacks()`; new compose-based action function; bounded discovery scan.
- Web: stack-root picker (reuse `FilesView`), richer stack cards in [`DockerStacks.tsx`](../apps/web/src/components/docker/DockerStacks.tsx) showing defined-vs-present services, deploy/up/down/pull buttons, optional editor.

## Build order (dependencies matter)

1. **Stack registry** — nothing else works without knowing where compose files live.
2. **Streaming exec** (or PTY reuse) — without it, compose actions silently time out.
3. **Detection / merge** — read + parse + reconcile.
4. **Compose actions** — `up` / `down` / `pull` / `restart` with safe path handling.
5. **UI** — root picker, richer cards, action buttons.
6. **Editor** — optional, last.

## Open questions

- How to surface the predicted-name vs. `config_files` matching ambiguity to the user (silent best-effort, or explicit "source unknown" badge for `orphaned`).
- Where exactly registry state persists and how it migrates with agent identity.
- YAML parser choice (add a dependency vs. minimal hand-parse of just `name:` + `services:` keys).
- Whether `down` should default to `docker compose down` (removes) or `stop` (preserves), given the destructive difference.
