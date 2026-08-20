import type { ApiEvent, ApiHandlerPrefixed, CentralApiOperations, FeatureDescriptor, TaskSpec } from "@central/shared";
import type { TaskHandlers } from "./tasks/types";

export interface FeatureBootCtx {
    configDir: string;
    broadcast(event: ApiEvent): void;
    // grows as features actually need shared infra — not a kitchen-sink up front
}

/** Every operation name in the wire protocol, and every task kind. */
export type ApiOp = keyof CentralApiOperations;
export type TaskKind = TaskSpec["kind"];

/** A feature's slice of `ApiHandlerPrefixed<CentralApiOperations>`, keyed by
 *  its own operation-name union — the return type every `<feature>ApiHandlers`
 *  factory declares instead of retyping the `Pick<...Capitalize...>` shape by
 *  hand each time. */
export type FeatureApiHandlers<T extends ApiOp> =
    Pick<ApiHandlerPrefixed<CentralApiOperations>, `handle${Capitalize<T>}`>;

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
export interface Feature<TOps extends ApiOp = never, TKinds extends TaskKind = never, TConfig = void> {
    descriptor: FeatureDescriptor;

    /** Mirrors the Fleet/AppStore/ProxyStore load-on-start pattern already used
     *  everywhere — a feature owns its own store and persists to its own
     *  `.sc-data/<id>.json`, same as today, just called through one uniform
     *  entry point instead of a bespoke `await x.init()` per feature. */
    init?(ctx: FeatureBootCtx): Promise<void>;

    apiHandlers?(): FeatureApiHandlers<TOps>;

    taskHandlers?(): FeatureTaskHandlers<TKinds>;

    /**
     * Task kinds this feature restricts to owners (`runTask` enforces it before
     * starting the run). Declared here rather than hard-coded in the tasks
     * feature so the gate travels with the code that knows why it exists — see
     * ZFS's pool/vdev mutations. `composeTaskHandlers` rejects a kind listed
     * here that the same feature doesn't actually handle, so a typo or a renamed
     * kind can't silently drop the gate.
     */
    ownerOnlyTaskKinds?: readonly TaskKind[];

    /** Only present for features with actual settings beyond their own store's
     *  data (an App list isn't "config" in this sense — it's the feature's
     *  data). */
    config?: {
        default: TConfig;
        load(raw: unknown): TConfig;
    };
}

/**
 * A feature with any operation/kind arguments. `never` is the bottom of both
 * parameters, so every concrete `Feature` is assignable to this — while an array
 * *literal* of features still remembers each element's own arguments, which is
 * what lets the `compose*` helpers below recover the union.
 */
export type AnyFeature = Feature<never, never, any>;

export type FeatureOps<F> = F extends Feature<infer O, any, any> ? O : never;
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
 * assigning the result to the full `ApiHandlerPrefixed<CentralApiOperations>`
 * is what enforces completeness: add an operation to the protocol and this
 * assignment fails, naming the missing `handle*` methods, instead of the gap
 * surfacing as a 404 at runtime.
 */
export function composeApiHandlers<F extends readonly AnyFeature[]>(features: F): FeatureApiHandlers<FeatureOps<F[number]>> {
    const slices = features.map((f) => ({ id: f.descriptor.id, slice: f.apiHandlers?.() }));
    return mergeSlices("operation", slices) as FeatureApiHandlers<FeatureOps<F[number]>>;
}

export interface ComposedTaskHandlers<K extends TaskKind> {
    handlers: FeatureTaskHandlers<K>;
    /** Union of every feature's `ownerOnlyTaskKinds`, for `runTask`'s gate. */
    ownerOnlyKinds: ReadonlySet<TaskKind>;
}

/** Same composition (and the same completeness guarantee) for task kinds. */
export function composeTaskHandlers<F extends readonly AnyFeature[]>(features: F): ComposedTaskHandlers<FeatureKinds<F[number]>> {
    const slices = features.map((f) => ({ id: f.descriptor.id, slice: f.taskHandlers?.() }));
    const handlers = mergeSlices("task kind", slices);

    const ownerOnlyKinds = new Set<TaskKind>();
    for (const feature of features) {
        const own = feature.taskHandlers?.() ?? {};
        for (const kind of feature.ownerOnlyTaskKinds ?? []) {
            if (!(kind in own)) {
                throw new Error(`Feature "${feature.descriptor.id}" gates task kind "${kind}" to owners but doesn't handle it`);
            }
            ownerOnlyKinds.add(kind);
        }
    }
    return { handlers: handlers as FeatureTaskHandlers<FeatureKinds<F[number]>>, ownerOnlyKinds };
}
