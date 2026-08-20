# Feature convention — code organization, not a plugin runtime

Status: implemented 2026-08-20 (`apps/server/src/feature.ts`, one
`apps/server/src/features/<id>/` directory per feature, composed in `index.ts`).
`CentralHandler` is gone. This doc remains the design record; the deliberately-deferred
list in §4 is still future work. Extended by
[idea_feature_interface.md](idea_feature_interface.md), which turns the shape described
here into an actual `Feature` type and carries the same idea to the frontend's nav/routing
dispatch — the frontend half of that doc is still unimplemented.

## 0. What this is (and isn't)

Prompted by a "should we go plugin-based" conversation. The answer landed on: don't
build a dynamic plugin runtime (self-registering modules, load-order resolution,
third-party-loadable code) — this is a single-team, single-deployment binary, and that
kind of isolation buys nothing here. What's worth doing is formalizing a convention this
codebase has *already* half-adopted for one layer (tasks) and applying it to the layer
that hasn't gotten it (the API handler).

## 1. Where the pattern already exists

`apps/server/src/tasks/types.ts` is the model to copy. It doesn't contain any real
logic — `zfsPoolCreate`, `dockerStackAction`, `systemdServiceAction` etc. live in
`zfs.ts`, `docker.ts`, `systemd.ts`, each a self-contained feature file. `types.ts` just
assembles them into one flat `taskHandlers: TaskHandlers` object, keyed by `TaskSpec["kind"]`,
and the type system enforces completeness: add a variant to the `TaskSpec` union in
`@central/shared` and `taskHandlers` won't typecheck until every kind has a handler
(comment at `tasks/types.ts:70-77` says this explicitly). That's a real plugin-style
boundary — each feature owns its slice, the registry is dumb — just without the word
"plugin" attached to it.

## 2. Where it didn't: `CentralHandler`

The problem this doc was written against, preserved as the motivating example.
`apps/server/src/handler.ts` was one 617-line class implementing `ApiHandlerPrefixed<CentralApiOperations>`
— every `handleX` method for every domain (auth/users, OIDC clients, Apps, Proxy,
servers, files, docker, zfs, systemd...) on one object, constructed in `index.ts:125`
with every store it might ever need injected positionally:

```ts
const handler = new CentralHandler(fleet, auth, nodeServer, taskRunner, taskStore, oidcStore, proxyManager, appStore);
```

This was the god-class the tasks side avoided. It grew by one constructor param and one
method per feature forever, and there was no compiler check that, say, the Apps handlers
only touch `appStore`/`fleet` and not `proxyManager` — everything could see everything
because it was all one `this`.

## 3. The fix: same shape as `taskHandlers`, applied here

Each feature exports a factory that builds *its slice* of the operations map:

```ts
// apps/server/src/features/apps/feature.ts (next to the feature's apps.ts store)
import type { ApiHandlerPrefixed, CentralApiOperations } from "@central/shared";
import type { AppStore } from "./apps";
import type { Fleet } from "./fleet";

type AppsOps = "listApps" | "createApp" | "detectApp" | "importApp" | "deleteApp"
    | "getAppStatus" | "getAppLogs" | "appServiceExec" | "validateComposeContent";

// The `Pick<...>` shape below is now spelled `FeatureApiHandlers<AppsOps>` (feature.ts).
export function appsApiHandlers(apps: AppStore, fleet: Fleet): Pick<ApiHandlerPrefixed<CentralApiOperations>, `handle${Capitalize<AppsOps>}`> {
    return {
        async handleListApps() { return apps.list(); },
        async handleCreateApp(data) { return apps.create(data.name, data.hostId, data.dir); },
        async handleDetectApp(data) { return apps.detect(data.hostId, data.dir, fleet); },
        // ...
    };
}
```

`index.ts` composes the full handler the same way it will already compose `taskHandlers`
conceptually — a spread, not a class:

```ts
const handler: ApiHandlerPrefixed<CentralApiOperations> = {
    ...authApiHandlers(auth),
    ...oidcApiHandlers(oidcStore, auth),
    ...appsApiHandlers(appStore, fleet),
    ...proxyApiHandlers(proxyManager),
    ...serversApiHandlers(fleet, nodeServer),
    // ...
};
```

Typed as the *full* (non-`Partial`) `ApiHandlerPrefixed<CentralApiOperations>`, so — same
trick as `TaskHandlers` — this won't compile if any operation in the union is missing
from every slice, or double-covered with conflicting signatures. `index.ts`'s
dispatch loop (`handler[method]`) doesn't change at all; it never cared whether `handler`
was a class instance or a plain object.

**As built**, the spread became `composeApiHandlers(features)`, because a literal spread
of `Partial` slices does *not* actually deliver that guarantee — see
[idea_feature_interface.md](idea_feature_interface.md) §1a for why, and for the two
inference traps (`Object.assign` returning `any`, and array-literal subtype reduction)
that silently defeated it on the first attempt. Double-coverage is caught at boot by
`composeApiHandlers` rather than by the compiler: two features claiming one operation is
a duplicate-key collision, which the type system can't see.

## 4. What stays centralized, on purpose

- **`CentralApiOperations` and `TaskSpec`/`TaskResult` stay single flat unions in
  `@central/shared`.** This is the opposite of "each feature defines its own protocol" —
  the one-flat-union-plus-completeness-check is exactly what makes both registries safe
  to compose from scattered files. Splitting the wire format per feature would lose that
  compile-time guarantee for a system with no external module authors to isolate from.
- **Boot order in `index.ts` stays explicit, not a resolved dependency graph.** `fleet`
  before `appStore` (`AppStore` takes `fleet` in its constructor), `tls` before
  `nodeServer`, etc. — six or seven stores with a fixed, documented order. A loader that
  discovers features and topologically sorts their dependencies would be solving a problem
  that doesn't exist yet: nobody adds or removes features at runtime, there's one
  deployment shape.
- **Cross-module dependencies stay direct, not hidden behind an event bus or DI
  container.** `docker_compose_action`'s task handler (`tasks/types.ts:231-244`) reaches
  into `ctx.apps: AppStore` because the Apps feature genuinely depends on Docker's
  compose-action code, and `TaskCtx` genuinely needs to carry both. Features here are a
  code-organization boundary, not a dependency-isolation one — pretending otherwise would
  mean routing an in-process call through an abstraction for no reason.

## 5. Directory moves this implies

**Done.** Every feature is now `src/features/<id>/`, holding its domain module(s) plus a
`feature.ts` that opens with the `create<X>Feature` factory — the feature's one entry
point, so it reads first — followed by the operation slice and any task handlers. The
rule that settled: *one directory per feature id; cross-cutting engines stay at the top
level.*

`auth.ts`, `fleet.ts`, `host-agent.ts`, `config.ts`, `fs-atomic.ts`, `node-server.ts`, and
`tasks/` are core, not features — nothing "owns" them the way Apps owns `apps.ts`. Note
this cuts across the feature/infra line in both directions and that's intended: the
*store* `auth.ts` is infra (the HTTP layer authenticates every request through it), while
the *operations* over it are `features/auth/feature.ts`. Same for `features/servers/feature.ts`
over `fleet.ts`/`node-server.ts` and `features/tasks/feature.ts` over `tasks/`.

The full list, 15 features: `apps`, `auth`, `docker`, `files`, `network`, `oidc`,
`processes`, `proxy`, `servers`, `settings`, `system-users`, `systemd`, `tasks`,
`terminal`, `zfs`.

## 6. Migration approach

**Done**, and it went as planned: incremental, one domain at a time, no behavior change at
any step, `scripts/check.sh` green throughout. The host-facing domains went first (apps,
docker, zfs, systemd, system-users, files, processes, network, terminal), then the
control-plane ones that emptied `CentralHandler` (auth, oidc, proxy, servers, settings,
tasks), and `handler.ts` was deleted once nothing was left in it.

One thing worth recording for the next refactor of this shape: the class was doing more
than holding methods — it was also the only place a few cross-feature couplings were
visible (`runTask` importing ZFS's owner-only kind list, for instance). Those don't
disappear when the class does; they have to be re-expressed as something a feature
*declares* (`Feature.ownerOnlyTaskKinds`) rather than something the composition root
knows.

## 7. Resolved questions

- **Does `handler.ts` disappear or become the composition point?** It disappeared. The
  doc leaned toward keeping it as the composer, but once composition was three lines
  (`composeApiHandlers(features)`) there was nothing left for the file to hold — a module
  whose whole body is one call is worse than the call at its only call site. `index.ts`
  owns the registry because it already owns the boot order the registry depends on, and
  the generic helpers live in `feature.ts`.
- **A `TaskCtx`-style shared bag for API handlers?** No — kept on explicit args, as the
  doc leaned. In practice most slices need exactly one or two collaborators (`fleet`,
  sometimes a store), and the explicit params are what make a slice readable in isolation.
- **Where does per-feature authorization live?** Not a question this doc asked, but the
  migration forced it: `Feature.ownerOnlyTaskKinds` lets a feature declare which of its
  task kinds are owner-only, so `runTask` enforces a gate it doesn't have to know the
  contents of. `composeTaskHandlers` rejects a kind gated by a feature that doesn't
  handle it, so the declaration can't silently rot.
