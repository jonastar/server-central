# Known Issues / Deferred Hardening

Tracked-but-not-yet-fixed issues, mostly fine at the current prototype scale.
Roughly ordered by how soon they'll bite. Items that have been fixed are recorded
in `changelog.md`, not here.

## Needs proper design

### Long-running / streaming `exec` (the 30s ceiling)

`HostAgent.request` has a fixed `REQUEST_TIMEOUT_MS = 30_000` and returns only a
final result. Anything that runs longer or streams progress — `docker compose
pull`/`up`, large image pulls, long-running scripts — will time out and produce
no live output. This is already a hard blocker for the stack-registry design
(see `doc/idea_stack_registry.md` § "Streaming exec"). Resolve before more
long-running features pile onto `exec`. Two candidate routes documented there:
reuse the PTY/`openShell` streaming path (fastest), or add dedicated
`execStream{Request,Chunk,End}` protocol messages (cleaner data model). Needs a
decision.

### Authorization / RBAC (host user mapping)

Every authenticated user currently has the full surface: root shell, root file
read/write across `/`, arbitrary `exec`, on every host. There's a `role` field
on users that's never enforced. Design mockup in
`doc/idea_rbac_host_users.md` (host-user mapping, account/group management,
sudo-nopasswd "admin" mapping). Needs implementation.

## Accepted for now (small scale)

- **Spec/dispatch layer is stringly-typed.** Handler dispatch is mitigated by the
  `handle*` prefix (see changelog 2026-06-24), but the operation registry is still
  a hand-maintained TS type with no runtime schema/validation. Planned rework:
  richer per-op metadata, likely zod, for runtime validation + OpenAPI generation.
  Until then, request bodies are trusted to match their declared types.
- **Session file rewritten on every authenticated request.** `AuthStore.authenticate`
  does a full-file `persistSessions()` to bump `lastSeenAt` on each request. Fine
  now; at scale, debounce or only persist when last-seen moves by more than N
  minutes.
- **Metrics broadcast fan-out.** `broadcast()` sends every agent's 5s metrics tick
  to every connected browser with no per-client subscription/filtering. Fine at
  small host/client counts; revisit for the multi-host goal.
- **Auth token in `localStorage`.** Readable by any JS on the page, so an XSS would
  expose it (an httpOnly cookie wouldn't be JS-readable — but introduces CSRF, the
  other side of the tradeoff). Also `Access-Control-Allow-Origin: *` on the API.
  Low risk while single-owner; tighten the origin and reconsider token storage when
  moving past prototype.

## Cleanups / polish

- **No structured logging.** Bare `console.log`/`console.warn` with ad-hoc
  `[update]`-style prefixes. A small leveled logger would help as host count grows.
- **Pure parsing logic is untested.** `docker.ts` (`parseJsonLines`, `parseLabel`),
  the `ps aux` parser in `handler.handleGetProcesses`, and systemd list merging are
  all pure, fragile string-splitting, and untested — while the harder networked
  paths *are* tested. Cheap, high-value unit tests to add.
- **`HISTORY_MAX = 720` duplicated** in `agent.ts` (`HISTORY_MAX`) and `host-agent.ts`
  (the literal `720`). Pull into `@central/shared`.
