import type { ApiEvent, ApiHandlerPrefixed, CentralApiOperations, FeatureDescriptor, HostCapability, HostCapabilityReport, HostCapabilityResult, TaskSpec } from "@central/shared";
import { HOST_CAPABILITIES } from "@central/shared";
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

    /** Mirrors the Fleet/ComposeStackStore/ProxyStore load-on-start pattern already used
     *  everywhere — a feature owns its own store and persists to its own
     *  `.sc-data/<id>.json`, same as today, just called through one uniform
     *  entry point instead of a bespoke `await x.init()` per feature. */
    init?(ctx: FeatureBootCtx): Promise<void>;

    apiHandlers?(): FeatureApiHandlers<TOps>;

    taskHandlers?(): FeatureTaskHandlers<TKinds>;

    /** Only present for features with actual settings beyond their own store's
     *  data (a stack registry isn't "config" in this sense — it's the feature's
     *  data). */
    config?: {
        default: TConfig;
        load(raw: unknown): TConfig;
    };
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
}

/** Same composition (and the same completeness guarantee) for task kinds. */
export function composeTaskHandlers<F extends readonly AnyFeature[]>(features: F): ComposedTaskHandlers<FeatureKinds<F[number]>> {
    const slices = features.map((f) => ({ id: f.descriptor.id, slice: f.taskHandlers?.() }));
    const handlers = mergeSlices("task kind", slices);
    return { handlers: handlers as FeatureTaskHandlers<FeatureKinds<F[number]>> };
}
