# Testing strategy

Status as of 2026-08-12. Plan, not yet executed — sequencing proposed at the bottom, nothing
built. Written because the app is growing into more system-mutating territory (Docker, ZFS,
next up: systemd-adjacent and possibly proxy/RBAC) and the cost of a silent regression there is
much higher than "the UI looks wrong."

## Where things actually stand

Worth stating plainly before proposing anything, since the instinct on "we need a testing
strategy" is usually to reach for new tools — but the backend already has real depth here:

- `apps/server/test/integration/*.test.ts` spins up a **real** `NodeServer` (TLS + WSS) and
  spawns the **real** `--agent` CLI as a subprocess — no mocked transport, no fake protocol
  objects. `agent-reconnect.test.ts`, `agent-connect.test.ts`, `task-orphan-reap.test.ts`, etc.
  cover the enroll → identify → fleet → metrics → reconnect path this way. This is a good
  pattern and the plan below extends it rather than replacing it with mocks.
- `test/env-preload.ts` + the two `bunfig.toml`s already solve a real footgun (a stray relative
  path write from a test corrupting a real running dev instance's `.sc-data`) by forcing
  `SC_DATA_DIR`/`SC_AGENT_DIR` to throwaway tmpdirs before any test file loads. Any new test
  layer inherits this for free as long as it runs through `bun test`.
- **Gap 1**: none of it touches the actual host-command paths. `docker.ts`, `zfs.ts`,
  `systemd.ts`, and `handler.ts`'s `handleGetProcesses` all go through one seam,
  `HostAgent.exec(cmd)`, which shells out to real `docker`/`zpool`/`systemctl`/`ps` on whatever
  host the agent runs on. Zero coverage today — not even the pure-parsing half.
  `known_issues.md` already flags this explicitly ("Pure parsing logic is untested":
  `docker.ts`'s `parseJsonLines`/`parseLabel`, the `ps aux` parser in `handleGetProcesses`,
  systemd's list-units/list-unit-files merge in `systemdList`).
- **Gap 2**: `bun test` isn't wired into CI at all. `.github/workflows/release.yml` only
  typechecks and builds on a tag push — the existing 20+ integration tests never run
  automatically anywhere.
- **Gap 3**: `apps/web` has no test infra whatsoever — no vitest, no Playwright, nothing in
  `package.json`. Zero frontend coverage, including pure logic (`ansi.ts`'s ANSI-to-HTML
  parsing, `routes.ts`'s hash ↔ route encode/decode, `taskFormat.ts`).

## The shape of the plan: four layers, cheapest-and-most-isolated first

### Layer 1 — pure-logic unit tests (no VM, no server, no network)

Backend: export the currently-private parsers where needed and feed them canned real command
output (captured from an actual `docker ps -a --format '{{json .}}'` / `zpool list -H -p ...` /
`systemctl list-units` run, not hand-invented strings) — `parseJsonLines`, `parseLabel`, the
`zfs.ts` dataset/pool/vdev-tree parsing, the `ps aux` splitter, `systemdList`'s merge logic.
These are pure functions of a string; a VM adds nothing here, and it's exactly what
`known_issues.md` already called out as cheap and high-value.

Frontend: same principle — `ansi.ts`, `routes.ts` (`routeToHash`/`hashToRoute`), `taskFormat.ts`
are all pure input → output and worth vitest coverage before touching component/E2E testing at
all. Cheapest tests in the whole plan, and they'd have caught real regressions in the hash-route
scheme already (per the "Store state in url" changelog entry, that surface has gotten fiddly).

This layer needs no infrastructure decision — just `bun test` (backend, already the runner) and
adding `vitest` to `apps/web` (frontend, currently absent).

### Layer 2 — protocol/integration tests (extend the existing pattern)

Keep doing exactly what `test/integration/` already does — real server, real agent subprocess,
real TLS — for anything that's fundamentally about the *control-plane ↔ agent protocol* rather
than what a specific host command does. This layer doesn't need Docker or ZFS installed at all;
it's already proven not to.

### Layer 3 — real system-command tests (Docker / ZFS / systemd): needs a VM-shaped environment

This is the part you asked about directly. The honest reason it's different from Layer 2: Layer
2 tests the protocol, which is deterministic and mockable-by-construction (it's SC's own
message format). Layer 3 would test SC's behavior against **another program's real CLI and
real system state** — a running Docker daemon, an actual `zpool`, live systemd units — which
can't be faked convincingly (parsing a hand-written fake `zpool status` tells you your parser
matches your assumptions about the format, not that it matches OpenZFS's actual output across
versions, which is the entire point of `idea_zfs.md`'s "don't depend on `-j`, ZoL 0.6.x support"
posture).

Two sub-cases with different risk profiles:

- **Docker**: low-risk to test almost anywhere. `docker` itself works fine inside a plain
  GitHub-hosted `ubuntu-latest` runner (it's already a VM with Docker preinstalled, not a
  container) — no nested-VM tooling needed. A `test:system:docker` suite that does real
  `docker run`/`docker compose up`/inspect/logs/remove cycles against ephemeral throwaway
  containers is safe to run in plain CI and safe-ish to run on a dev machine that already has
  Docker (still opt-in, since it does create/destroy real containers).
- **ZFS** and **systemd unit management**: higher-risk, needs an actually disposable box.
  `zpool create`/`destroy` against a loopback-file-backed pool is safe *if* it's guaranteed to
  never run against a real pool by accident — that guarantee is much easier to make inside a
  disposable VM than "trust the test to only ever touch `/tmp/scratch.img`." Same logic for
  systemd: `systemctl enable/disable/start/stop` on a throwaway test unit is fine, but you don't
  want that logic anywhere near a machine's real units without a hard boundary. `ubuntu-latest`
  runners can apt-install `zfsutils-linux` and modprobe zfs (it's a real VM with its own
  kernel), so — same as Docker — CI may not need bespoke VM tooling at all. What's still an open
  question is the **local dev loop**: do you want this reproducible on a laptop without
  installing real ZFS/touching the host's module state? If so, a small disposable VM (`lima`,
  `multipass`, or a throwaway `vagrant up` box) mirroring the CI image is the right shape — not
  because CI needs it, but because a developer's day-to-day machine shouldn't need `zpool`
  installed to iterate on `zfs.ts`.

Regardless of where it runs, this layer should be its own opt-in script (`test:system` or
similar), separate from the default `bun test`, so the fast inner loop (Layers 1+2) stays fast
and nobody's real Docker/ZFS/systemd state gets touched by running the default suite.

### Layer 4 — Playwright E2E (frontend, thin on purpose for now)

Useful, but sequence it last and keep it small at first. Reasoning: the README calls this a
prototype stage and the UI is still moving fast (routes, wizards, and whole views have been
reshaped repeatedly per `next.md`'s archive — Docker rework, hash-routing rework, setup wizard).
A broad E2E suite written against today's DOM/flows becomes a maintenance tax every time a view
gets reshaped, which is often right now. A **thin smoke suite** — login, add-node happy path
through the setup wizard, one or two read-heavy views loading without erroring (Docker overview,
Files) — earns its keep immediately (catches "the page is just broken") without much upkeep
cost, and can grow as specific flows stabilize. Full coverage of every view is a later-stage
investment, not a now one.

## CI wiring

Independent of all four layers and worth doing regardless of what's built next: add a `test`
job to `.github/workflows/release.yml` (or a new `ci.yml` that runs on PRs, not just tag
pushes) that runs `bun test` — Layers 1+2 only, fast, no special runner needs. Layer 3
(`test:system`) and Layer 4 (Playwright) get their own CI jobs once they exist, since they have
different runtime/installation needs (Docker/ZFS packages, a browser).

## Proposed sequencing

1. Backend Layer 1 (parser unit tests) — closes a gap already flagged in `known_issues.md`,
   no infra decisions to make.
2. CI wiring for the existing suite + new Layer 1 tests (`bun test` on every PR).
3. Frontend Layer 1 (vitest for `ansi.ts`/`routes.ts`/`taskFormat.ts`) — same shape, low cost.
4. Layer 3, Docker half only — real container lifecycle tests, runs fine on stock
   `ubuntu-latest`, no VM-tooling decision needed yet.
5. Layer 3, ZFS/systemd half — this is where the local-VM-tooling choice (lima/multipass/vagrant
   vs. CI-only coverage) actually needs deciding; revisit once Docker's version of this layer
   exists as a template.
6. Layer 4 (Playwright smoke suite) — once a few more core flows have settled down.

Steps 1–4 don't depend on any open decision and could start immediately; 5 and 6 have a real
tradeoff each (local VM tooling investment; how thin "thin" should be) worth a short discussion
when we get there rather than deciding now.
