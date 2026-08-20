# Feature interface — descriptor, lifecycle, frontend registry

Status: **§1 (server `Feature`) implemented 2026-08-20** — `apps/server/src/feature.ts`,
one directory per feature under `apps/server/src/features/`, composed in `index.ts`.
**§2 (frontend registry) not implemented** — `App.tsx`'s dispatch chain and
`Sidebar.tsx`'s hand-written nav are still as described below, and remain the natural next
step. §3 (config) is present as an unused `Feature.config` slot. This doc remains the
design record. Builds on
[idea_feature_convention.md](idea_feature_convention.md), which established the shape
(feature-owned files, composed into flat registries, no dynamic plugin loader) without a
formal interface. This doc gives that shape an actual `Feature` type, and extends the same
idea to the frontend's nav/routing dispatch, which has the identical hand-written-chain
problem on the other side of the wire.

## 1. Server-side `Feature` interface

The original sketch, kept for the reasoning in its comments:

```ts
// apps/server/src/feature.ts (as sketched — see the built version below)
import type { ApiHandlerPrefixed, CentralApiOperations, FeatureDescriptor } from "@central/shared";
import type { TaskHandlers } from "./tasks/types";

export interface FeatureBootCtx {
    configDir: string;
    broadcast(event: ApiEvent): void;
    // grows as features actually need shared infra — not a kitchen-sink up front
}

export interface Feature<TConfig = void> {
    descriptor: FeatureDescriptor;

    /** Mirrors the Fleet/AppStore/ProxyStore load-on-start pattern already used
     *  everywhere (`index.ts:81,84,87,90,112,122`) — a feature owns its own store
     *  and persists to its own `.sc-data/<id>.json`, same as today, just called
     *  through one uniform entry point instead of a bespoke `await x.init()` per
     *  feature. */
    init?(ctx: FeatureBootCtx): Promise<void>;

    /** This feature's slice of the operations map — see idea_feature_convention.md
     *  §3. Composed with every other feature's slice into one object typed as the
     *  *full*, non-Partial `ApiHandlerPrefixed<CentralApiOperations>`, so a missing
     *  operation is a compile error, not a 404 discovered at runtime. */
    apiHandlers?(): Partial<ApiHandlerPrefixed<CentralApiOperations>>;

    /** This feature's slice of `TaskHandlers` — same completeness trick, already
     *  proven by `tasks/types.ts`. */
    taskHandlers?(): Partial<TaskHandlers>;

    /** Only present for features with actual settings beyond their own store's data
     *  (an App list isn't "config" in this sense — it's the feature's data). */
    config?: {
        default: TConfig;
        load(raw: unknown): TConfig;
    };
}
```

**As built** the interface picked up three things the sketch didn't have — see §1a:

```ts
export interface Feature<TOps extends ApiOp = never, TKinds extends TaskKind = never, TConfig = void> {
    descriptor: FeatureDescriptor;
    init?(ctx: FeatureBootCtx): Promise<void>;
    apiHandlers?(): FeatureApiHandlers<TOps>;      // not Partial<...>
    taskHandlers?(): FeatureTaskHandlers<TKinds>;  // not Partial<...>
    ownerOnlyTaskKinds?: readonly TaskKind[];      // new — see convention doc §7
    config?: { default: TConfig; load(raw: unknown): TConfig };
}
```

```ts
// shared/src/index.ts — the one piece both sides need to agree on
export interface FeatureDescriptor {
    id: string;              // stable key: config storage, dependsOn refs, task-kind
                              // prefixing, and the frontend's matching id. Never
                              // renamed, never shown to the user.
    name: string;
    description: string;
    experimental: boolean;
    dependsOn?: string[];     // other features' ids — see §4, inert metadata for now
}
```

`index.ts` composes the registries (per `idea_feature_convention.md` §3):

```ts
const features = defineFeatures(appsFeature, authFeature, proxyFeature, /* ... */);
for (const f of features) await f.init?.(bootCtx);
const handler: ApiHandlerPrefixed<CentralApiOperations> = composeApiHandlers(features);
const { handlers, ownerOnlyKinds } = composeTaskHandlers(hostFeatures);
```

Boot order stays the explicit array above, not a resolved graph — same reasoning as
`idea_feature_convention.md` §4 (`fleet` before `appStore`, `tls` before `nodeServer`,
etc., all documented today as plain sequential code). It is split into two registries in
practice: host features are constructed before the `TaskRunner` because they supply its
kinds, and the control-plane features after it because the tasks feature needs the runner.

## 1a. Why composition needs helpers (the part the sketch got wrong)

The whole justification for one flat `CentralApiOperations` union is the compile-time
completeness check: *"a missing operation is a compile error, not a 404 discovered at
runtime."* The sketch above does not deliver it, and neither did the first implementation.
Two separate traps, both of which fail **open** — the code compiles and looks right while
checking nothing:

1. **`Object.assign({}, ...sources)` returns `any`.** Spreading `any` into an object
   literal satisfies any annotation, so `const handler: ApiHandlerPrefixed<...> =
   Object.assign(...)` typechecks no matter what is missing. The fix is a helper whose
   return type is the *union of the features' declared operations*
   (`FeatureApiHandlers<FeatureOps<F[number]>>`), so the assignment at the call site is a
   real check. This is also why `apiHandlers()` returns a precise slice rather than
   `Partial<ApiHandlerPrefixed<...>>`: `Partial` erases which operations a feature claims,
   and the union has nothing left to compute.

2. **Array-literal inference applies subtype reduction.** Given
   `const features = [appsFeature, /* ... */, terminalFeature]`, TypeScript reduces the
   inferred element union to its most general member. A feature claiming no operations
   (`Feature<never, never>` — the terminal feature) is a *supertype* of every other
   feature, so the element type collapses to it and every other feature's operations are
   erased. `defineFeatures(...)` exists solely to force rest-parameter *tuple* inference,
   which keeps each element's own type; spreading one result into another preserves it.

Both are worth knowing before extending this pattern. The saving grace is that when the
inference does collapse, the composed type becomes `FeatureApiHandlers<never>` and the
assignment fails loudly with all ~85 operations missing — noisy, not silent. Verify a
change to this machinery by deleting a feature from the registry and confirming the build
names the operation it just lost.

## 2. Frontend: a parallel registry, not a parallel design

`apps/web/src` has the identical shape of problem on the other side of the wire:
`routes.ts:18-27` is a flat `Route` union, `App.tsx:54-164` is a hand-written
`if (route.view === "x")` chain picking a component per view, and `Sidebar.tsx` hand-writes
one nav button per feature with its own `onClick`. Every new feature (Apps, most recently)
means touching all three by hand — the frontend equivalent of `CentralHandler` growing a
method per feature.

The fix is the same shape, but it is genuinely a separate type on the frontend, not the
same `Feature` reused: a React component reference and an icon can't live in `@central/shared`
(the server package has no business importing React), so only the *identity* is shared —
`FeatureDescriptor` above — and the implementation is frontend-native:

```ts
// apps/web/src/features.ts
import type { FeatureDescriptor } from "@central/shared";
import type { ComponentType, ReactNode } from "react";
import type { Route } from "./routes";

export interface FrontendFeature<TView extends Route["view"] = Route["view"]> {
    descriptor: FeatureDescriptor;   // same id as the matching server Feature
    nav: { label: string; icon: ComponentType; order: number };
    view: TView;                     // this feature's top-level Route["view"] tag
    render(route: Extract<Route, { view: TView }>): ReactNode;
}
```

`Sidebar.tsx` becomes `features.sort(by order).map(f => <NavButton descriptor={f.descriptor} nav={f.nav} .../>)`
instead of one hand-written block per feature. `App.tsx`'s dispatch chain becomes a lookup
by `route.view` into the registry instead of the if-chain.

**What stays hand-written, on purpose**: the `Route` union and `routes.ts`'s hash-parsing
logic. Parsing a URL into a `Route` is one global concern — one string maps to exactly one
route — and the per-view parsing already in there (server tab/section/volume/path
disambiguation, `routes.ts:163-185`) is genuinely intertwined logic, not per-feature
boilerplate. Splitting URL parsing across feature files would cost more than the
hand-written chain it replaces; the registry should own "given a view, what renders and
what's in the sidebar," not "how a URL becomes a route."

## 3. Config

No per-feature config store exists today — `config.ts` is one flat `Config` object. A
feature with a `config` block (§1) gets a namespaced slot inside it (`config.features[id]`),
loaded/validated through `Feature.config.load` at boot, persisted through the same
save-on-change path `readConfig`/`writeConfig` already use. Most features won't need this —
`AppStore`, `ProxyStore`, `TaskStore` already have their own data files and don't need a
second "config" concept layered on top.

## 4. Deliberately deferred

Same list as `idea_feature_convention.md` §4, restated concretely against this interface:

- **No `setEnabled` method.** When toggling is built, it's a runtime flag the dispatcher
  checks against `descriptor.id` before calling into a feature's handlers/task
  kinds/nav entry — not a method every feature has to implement, most of which would do
  nothing but flip a boolean.
- **`dependsOn` is metadata, not a scheduler.** Used for validation ("can't enable Apps
  while Docker is disabled") and a UI hint once toggling exists; boot order stays the
  hand-written array in §1.
- **Per-host scoping is out of scope, but shapes one decision now**: if "enabled" might
  ever be per-host rather than global (e.g. a ZFS-adjacent feature only relevant on hosts
  with pools), future enabled-state should key on `(featureId, hostId | null)` from the
  day it's built, not `featureId` alone. Nothing to build today, just a note so the later
  design doesn't require reshaping this interface.

## 5. Migration

The server half is done (see `idea_feature_convention.md` §6). The frontend half is not,
and the plan for it is unchanged: for each domain still hand-wired in
`Sidebar.tsx`/`App.tsx`, build its `FrontendFeature` against the **descriptor id the
server feature already uses** — those ids are now fixed and in use (`apps`, `auth`,
`docker`, `files`, `network`, `oidc`, `processes`, `proxy`, `servers`, `settings`,
`system-users`, `systemd`, `tasks`, `terminal`, `zfs`), so the frontend registry should
match them rather than invent its own.

Note that a `FeatureDescriptor` is not yet exposed over the wire — nothing serves the
feature list to the client today. A frontend registry can be built without it (matching
ids by hand, compile-checked on the frontend the same way), but a `listFeatures` operation
becomes worth adding the moment enablement (§4) is real.

## 6. Open questions

- ~~Whether `FeatureBootCtx` needs to exist yet~~ — **settled: both.** Stores still take
  explicit constructor args (`new AppStore(fleet)`) at the composition root, and
  `Feature.init` is the thin wrapper that calls `store.init()`. `FeatureBootCtx` exists
  because `init` *does* have a uniform caller (the boot loop), unlike API handlers, but so
  far no feature reads either field off it. It's carrying its weight as the seam, not as a
  dependency source; if it's still unread when the next few features land, drop it and let
  `init()` take nothing.
- One thing to watch: feature `init()` now runs *after* the node server starts listening,
  because the registry can't be assembled until the `TaskRunner` exists. Nothing reads a
  feature store before the HTTP server accepts requests, so it's currently safe — but a
  feature whose `init` must complete before an agent can connect would not be, and that's
  a boot-order constraint the two-registry split makes easy to miss.
- Whether `FrontendFeature.view` should support a feature owning more than one top-level
  `Route["view"]` (e.g. a hypothetical feature with both a list and a detail view, like
  Apps' `"apps"`/`"app"` pair today). Probably yes eventually — `view` becomes `view: TView[]`
  and `render` narrows per tag — but not needed for the first extraction.
- Whether `Feature` needs a control-plane-vs-node distinction (an `env` field on
  `FeatureBootCtx`, or a separate `initNode`). It doesn't today: `--agent` exits
  (`index.ts`'s `--agent` branch) before the control-plane boot sequence that composes features ever
  runs, so `Feature.init` never executes on a node — features are a control-plane-only
  concept, same as `TaskRunner`/`broadcast` already are. Node-side logic
  today runs through commands dispatched to the agent, not through feature code. If nodes
  ever need to run substantial custom feature code of their own (beyond command dispatch),
  a dedicated `initNode` — not an `env` flag branching inside one `init` — is the shape to
  reach for then, since it'd be a genuinely different lifecycle/entry point, not a runtime
  check.
