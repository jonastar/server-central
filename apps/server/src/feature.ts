import type { ApiEvent, ApiHandler, ApiHandlers, ApiNamespace, CentralApiOperations, FeatureDescriptor, HostCapability, HostCapabilityReport, HostCapabilityResult, TaskSpec } from "@central/shared";
import { HOST_CAPABILITIES } from "@central/shared";
import type { TaskHandlers } from "./tasks/types";

/**
 * A raw HTTP route: a path outside the JSON-RPC surface that a feature answers
 * directly, with its own request/response shape.
 *
 * The RPC layer covers everything a browser calls with a session bearer token.
 * A handful of endpoints can't live there — OIDC's token and userinfo endpoints
 * are form-encoded and client-authenticated per spec, and discovery/JWKS are
 * public GETs at fixed well-known paths. Those used to be special-cased in the
 * composition root, which meant the OIDC feature's own surface was split across
 * two files; this is how a feature declares them itself.
 *
 * Matching is exact on `path` and (when given) `method`. Routes are matched
 * before the RPC prefix and before static assets, so a feature cannot shadow an
 * operation by accident — the paths are disjoint by construction.
 */
export interface HttpRoute {
    path: string;
    method?: string;
    /** `cors` is the already-resolved `Access-Control-*` header set for this
     *  request — the same one the RPC layer answers with. */
    handle(req: Request, cors: Record<string, string>): Promise<Response>;
}

export interface FeatureBootCtx {
    configDir: string;
    broadcast(event: ApiEvent): void;
    // grows as features actually need shared infra — not a kitchen-sink up front
}

/** Every task kind. Namespaces come from `ApiNamespace` in the protocol. */
export type TaskKind = TaskSpec["kind"];

/**
 * A feature's slice of the handler map: its own namespace and the operations in
 * it.
 *
 * A feature owns exactly one namespace, and a namespace key *is* a feature id —
 * so this is `Pick` of a single key, and the nesting in the returned object is
 * the feature declaring which namespace it answers for. That declaration is
 * type-checked against the protocol, which is what lets `composeApiHandlers`
 * prove coverage without trusting `descriptor.id` at runtime.
 */
export type FeatureApiHandlers<N extends ApiNamespace> =
    Pick<ApiHandlers<CentralApiOperations>, N>;

/** Just the operations of one namespace, without the namespace key wrapping
 *  them — what `defineFeature` takes as `ops`. */
export type InnerFeatureApiHandlers<N extends ApiNamespace> =
    ApiHandler<CentralApiOperations[N]>;

/** A feature's slice of `TaskHandlers`, keyed by the kinds it owns. */
export type FeatureTaskHandlers<K extends TaskKind> = Pick<TaskHandlers, K>;

/**
 * One feature's contribution to the control plane.
 *
 * `TOps`/`TKinds` are the operations and task kinds this feature claims. They're
 * declared, not inferred, because `composeApiHandlers`/`composeTaskHandlers`
 * union them across the registry to prove — at compile time — that every
 * operation in `CentralApiOperations` and every kind in `TaskSpec` is covered
 * exactly once. A feature that widens its `Ops` union without adding the handler
 * fails to typecheck at its own factory; one that narrows it fails at the
 * registry, where the composed slice no longer satisfies the full map.
 */
export interface Feature<TNs extends ApiNamespace = never, TKinds extends TaskKind = never, TConfig = void> {
    descriptor: FeatureDescriptor;

    /** Mirrors the Fleet/ComposeStackStore/ProxyStore load-on-start pattern already used
     *  everywhere — a feature owns its own store and persists to its own
     *  `.sc-data/<id>.json`, same as today, just called through one uniform
     *  entry point instead of a bespoke `await x.init()` per feature. */
    init?(ctx: FeatureBootCtx): Promise<void>;

    apiHandlers?(): FeatureApiHandlers<TNs>;

    /** Raw (non-RPC) HTTP endpoints this feature owns — see {@link HttpRoute}. */
    httpRoutes?(): HttpRoute[];

    taskHandlers?(): FeatureTaskHandlers<TKinds>;

    /** Only present for features with actual settings beyond their own store's
     *  data (a stack registry isn't "config" in this sense — it's the feature's
     *  data). */
    config?: {
        default: TConfig;
        load(raw: unknown): TConfig;
    };
}

/**
 * One feature, declared as data.
 *
 * Everything about a feature is inferred from this literal rather than restated:
 * `id` fixes the API namespace (they are the same string by construction), and
 * the keys of `tasks` fix the task kinds. That replaces a `Feature<"systemd",
 * "service_action">` annotation that repeated both, plus a `descriptor` nested
 * one level down, plus a namespace key wrapping `ops`.
 *
 * `ops` is typed `never` when `id` isn't an API namespace, so a feature that
 * serves no operations (terminal, debug) can't accidentally declare some — and
 * one that does gets its handlers checked against the protocol, with `data` and
 * the return type contextually typed from it. Nothing here needs an annotation.
 *
 * This stays a *factory* argument, not a module-level constant: features take
 * their collaborators explicitly (`fleet`, a store, a callback), and the `tasks`
 * feature takes the runner that is itself built from the feature registry. So
 * the idiom is `export const createXFeature = (deps) => defineFeature({...})`.
 */
export interface FeatureDesc<TId extends string, TKinds extends TaskKind> {
    /** Stable key: config storage, `dependsOn` refs, the frontend's matching id
     *  — and, when the feature serves operations, its API namespace. */
    id: TId;
    name: string;
    description: string;
    /** Defaults to false. */
    experimental?: boolean;
    dependsOn?: string[];
    requiresHostCapability?: HostCapability;
    init?(ctx: FeatureBootCtx): Promise<void>;
    /** This namespace's operations, unwrapped. `never` when `id` names no namespace. */
    ops?: TId extends ApiNamespace ? InnerFeatureApiHandlers<TId> : never;
    /** Task kinds this feature owns; the keys are the claim. */
    tasks?: FeatureTaskHandlers<TKinds>;
    httpRoutes?(): HttpRoute[];
}

export function defineFeature<TId extends string, TKinds extends TaskKind = never>(
    desc: FeatureDesc<TId, TKinds>,
): Feature<TId extends ApiNamespace ? TId : never, TKinds> {
    type Ns = TId extends ApiNamespace ? TId : never;
    const feature: Feature<Ns, TKinds> = {
        descriptor: {
            id: desc.id,
            name: desc.name,
            description: desc.description,
            experimental: desc.experimental ?? false,
            ...(desc.dependsOn ? { dependsOn: desc.dependsOn } : {}),
            ...(desc.requiresHostCapability ? { requiresHostCapability: desc.requiresHostCapability } : {}),
        },
    };
    if (desc.init) {
        feature.init = desc.init;
    }
    if (desc.ops) {
        // Re-wrap under the namespace key the registry merges on. `id` is the
        // namespace by construction, which is what the `ops` type above proves.
        const wrapped = { [desc.id]: desc.ops } as unknown as FeatureApiHandlers<Ns>;
        feature.apiHandlers = () => wrapped;
    }
    if (desc.tasks) {
        const tasks = desc.tasks;
        feature.taskHandlers = () => tasks;
    }
    if (desc.httpRoutes) {
        feature.httpRoutes = desc.httpRoutes;
    }
    return feature;
}

// ---- The node-side half -----------------------------------------------------
//
// A feature's contribution to the *agent*, which runs on a managed host. Kept a
// separate object from `Feature` rather than more optional members on it, for a
// blunt reason: every host-feature factory takes control-plane dependencies
// (`Fleet`, `AuthStore`, `ComposeStackStore`) that don't exist on a node — a node has no
// fleet, it *is* a host. Building the control-plane registry there would mean
// passing fakes into constructors just to reach a method that ignores them.
//
// Both halves live in the same `features/<id>/feature.ts`, so what a feature
// needs and how a host answers for it still sit next to each other; only the
// composition is split. The agent registry needs no dependencies at all, which
// is also why it has no `init` — there's nothing to wire up.

export interface AgentFeature {
    /** Matches the control-plane `Feature`'s `descriptor.id`. */
    id: string;

    /**
     * Answer whether this feature's subsystem is actually usable on this host.
     *
     * Runs on the node, on every connect and on demand — so it must be cheap and
     * must never throw. Probe natively (filesystem, /proc) rather than shelling
     * out: the distinction worth reporting is *usable* vs merely *installed*, and
     * a false positive un-greys a tab that then errors, which is worse than never
     * having probed. An unavailable result must carry a `detail` a user can act
     * on — it's the only explanation the UI has.
     */
    hostProbe?: {
        capability: HostCapability;
        probe(): Promise<HostCapabilityResult>;
    };
}

/** Register the node-side features. Plain array, no inference trickery needed:
 *  unlike `defineFeatures` there are no per-element type arguments to preserve. */
export function defineAgentFeatures(...features: AgentFeature[]): readonly AgentFeature[] {
    return features;
}

/**
 * Every `HostCapability` in the shared union must have exactly one feature
 * probing it.
 *
 * This is the agent-side counterpart to what `composeApiHandlers` proves for
 * operations, split into two steps because the two registries can't see each
 * other: `requiresHostCapability` is typed to `HostCapability`, so a feature can
 * only ask for an id in the union — and this asserts the node registry answers
 * every id in that union. Together they mean a control-plane feature can't
 * declare a need no agent can answer, which would otherwise surface as a
 * permanently-unknown capability and a tab that never greys.
 */
export function assertHostProbeCoverage(features: readonly AgentFeature[]): void {
    const owners = new Map<HostCapability, string>();
    for (const feature of features) {
        if (!feature.hostProbe) {
            continue;
        }
        const existing = owners.get(feature.hostProbe.capability);
        if (existing) {
            throw new Error(`Feature "${feature.id}" and "${existing}" both probe host capability "${feature.hostProbe.capability}"`);
        }
        owners.set(feature.hostProbe.capability, feature.id);
    }
    const missing = HOST_CAPABILITIES.filter((c) => !owners.has(c));
    if (missing.length) {
        throw new Error(`No agent feature probes host capability: ${missing.join(", ")}`);
    }
}

/**
 * Run every declared host probe, keyed by capability.
 *
 * Rejects two features claiming one capability, same as `mergeSlices` does for
 * operations — the type system can prove coverage but not uniqueness.
 */
export async function composeHostProbes(features: readonly AgentFeature[]): Promise<HostCapabilityReport> {
    const owners = new Map<HostCapability, string>();
    const probes: Array<{ capability: HostCapability; id: string; run: () => Promise<HostCapabilityResult> }> = [];
    for (const feature of features) {
        if (!feature.hostProbe) {
            continue;
        }
        const { capability, probe } = feature.hostProbe;
        const existing = owners.get(capability);
        if (existing) {
            throw new Error(`Feature "${feature.id}" and "${existing}" both probe host capability "${capability}"`);
        }
        owners.set(capability, feature.id);
        probes.push({ capability, id: feature.id, run: () => probe() });
    }

    const results = await Promise.all(probes.map(async ({ capability, id, run }): Promise<[HostCapability, HostCapabilityResult]> => {
        try {
            return [capability, await run()];
        } catch (err) {
            // One bad probe must not take down the report — it rides on identify,
            // so a throw here would fail the whole connect.
            return [capability, { available: false, detail: `Probe for "${id}" failed: ${(err as Error).message}` }];
        }
    }));
    return Object.fromEntries(results) as HostCapabilityReport;
}

/**
 * A feature with any operation/kind arguments. `never` is the bottom of both
 * parameters, so every concrete `Feature` is assignable to this — while an array
 * *literal* of features still remembers each element's own arguments, which is
 * what lets the `compose*` helpers below recover the union.
 */
export type AnyFeature = Feature<never, never, any>;

export type FeatureNs<F> = F extends Feature<infer N, any, any> ? N : never;
export type FeatureKinds<F> = F extends Feature<any, infer K, any> ? K : never;

/**
 * Register a list of features, preserving each one's declared operations and
 * task kinds.
 *
 * This exists instead of a plain array literal for a specific TypeScript reason:
 * inferring the element type of an array literal applies *subtype reduction*, and
 * a feature that claims no operations (`Feature<never, never>` — the terminal
 * feature today) is a supertype of every other feature. That one element would
 * collapse the whole element union down to itself, erasing every other feature's
 * operations and quietly turning the completeness checks below into no-ops.
 * Rest-parameter inference produces a tuple instead, which keeps each element's
 * own type. Spreading one `defineFeatures` result into another preserves it too,
 * so registries can be built up in stages.
 */
export function defineFeatures<F extends readonly AnyFeature[]>(...features: F): F {
    return features;
}

/** Merge per-feature slices into one flat registry, rejecting two features that
 *  claim the same key — the runtime half of the compile-time completeness
 *  check, since the type system can prove nothing is *missing* but not that
 *  nothing is claimed twice. */
function mergeSlices(label: string, slices: { id: string; slice: object | undefined }[]): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    const owners: Record<string, string> = {};
    for (const { id, slice } of slices) {
        for (const [key, value] of Object.entries(slice ?? {})) {
            if (key in merged) {
                throw new Error(`Feature "${id}" and "${owners[key]}" both provide ${label} "${key}"`);
            }
            merged[key] = value;
            owners[key] = id;
        }
    }
    return merged;
}

/**
 * Compose every feature's API slice into one handler object.
 *
 * The return type is the *union* of the features' declared operations, so
 * assigning the result to the full `ApiHandlers<CentralApiOperations>` is what
 * enforces completeness: add a namespace to the protocol and this assignment
 * fails, naming it, instead of the gap surfacing as a 404 at runtime. A missing
 * *operation* fails earlier still — at the owning feature's own factory, since
 * `FeatureApiHandlers<"docker">` requires every operation in that namespace.
 */
export function composeApiHandlers<F extends readonly AnyFeature[]>(features: F): FeatureApiHandlers<FeatureNs<F[number]>> {
    const slices = features.map((f) => ({ id: f.descriptor.id, slice: f.apiHandlers?.() }));
    return mergeSlices("namespace", slices) as FeatureApiHandlers<FeatureNs<F[number]>>;
}

/**
 * Flatten the nested handler map into the table the dispatcher reads, keyed by
 * the qualified `"<namespace>/<operation>"` wire name.
 *
 * A `Map` rather than an object on purpose: the key comes straight off the
 * request path, and a `Map` has no prototype for `constructor`/`__proto__` to
 * resolve against. That is what replaced the old `handle` name-prefixing — the
 * lookup itself can no longer reach anything that isn't a registered operation.
 */
export function flattenApiHandlers(handlers: ApiHandlers<CentralApiOperations>): Map<string, (data: unknown, ctx: unknown) => Promise<unknown>> {
    const table = new Map<string, (data: unknown, ctx: unknown) => Promise<unknown>>();
    for (const [namespace, ops] of Object.entries(handlers as Record<string, Record<string, unknown>>)) {
        for (const [op, fn] of Object.entries(ops)) {
            table.set(`${namespace}/${op}`, (fn as (d: unknown, c: unknown) => Promise<unknown>).bind(ops));
        }
    }
    return table;
}

/**
 * Flatten every feature's raw HTTP routes into one table, rejecting two features
 * that claim the same path+method. There's no completeness check to make here —
 * unlike operations and task kinds, no central union enumerates these — so the
 * uniqueness check is the whole job.
 */
export function composeHttpRoutes(features: readonly AnyFeature[]): Map<string, HttpRoute> {
    const routes = new Map<string, HttpRoute>();
    const owners = new Map<string, string>();
    for (const feature of features) {
        for (const route of feature.httpRoutes?.() ?? []) {
            const key = `${route.method ?? "*"} ${route.path}`;
            const existing = owners.get(key);
            if (existing) {
                throw new Error(`Feature "${feature.descriptor.id}" and "${existing}" both serve "${key}"`);
            }
            owners.set(key, feature.descriptor.id);
            routes.set(key, route);
        }
    }
    return routes;
}

/** Look up a raw route for a request, preferring a method-specific entry. */
export function matchHttpRoute(routes: Map<string, HttpRoute>, method: string, path: string): HttpRoute | undefined {
    return routes.get(`${method} ${path}`) ?? routes.get(`* ${path}`);
}

/** Same composition (and the same completeness guarantee) for task kinds. */
export function composeTaskHandlers<F extends readonly AnyFeature[]>(features: F): FeatureTaskHandlers<FeatureKinds<F[number]>> {
    const slices = features.map((f) => ({ id: f.descriptor.id, slice: f.taskHandlers?.() }));
    return mergeSlices("task kind", slices) as FeatureTaskHandlers<FeatureKinds<F[number]>>;
}
