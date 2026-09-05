
import type { HostCapability } from "./domain/host-capabilities";
import type { AuthOperations } from "./domain/auth";
import type { ComposeOperations } from "./domain/compose";
import type { DashboardOperations } from "./domain/dashboards";
import type { DockerOperations } from "./domain/docker";
import type { FilesOperations } from "./domain/files";
import type { NetworkOperations } from "./domain/network";
import type { OidcOperations } from "./domain/oidc";
import type { ProcessesOperations } from "./domain/processes";
import type { ProxyOperations } from "./domain/proxy";
import type { ServersOperations } from "./domain/servers";
import type { SettingsOperations } from "./domain/settings";
import type { SystemUsersOperations } from "./domain/system-users";
import type { SystemdOperations } from "./domain/systemd";
import type { ZfsOperations } from "./domain/zfs";
import type { TasksOperations } from "./tasks";
import type { ServerEntry, ServerStatus } from "./domain/servers";
import type { MetricsSnapshot } from "./metrics";
import type { TaskLogLine, TaskRun } from "./tasks";

// One barrel for the whole wire protocol. Each domain owns its own file — its
// types and its slice of the operation map, next to each other — and this file
// assembles them. Nothing here should grow a domain type of its own; add it to
// (or create) the domain file and re-export it below.

export * from "./node-protocol";
export * from "./metrics";
export * from "./tasks";
export * from "./permissions";

export * from "./domain/auth";
export * from "./domain/compose";
export * from "./domain/dashboards";
export * from "./domain/docker";
export * from "./domain/files";
export * from "./domain/host-capabilities";
export * from "./domain/logs";
export * from "./domain/network";
export * from "./domain/oidc";
export * from "./domain/processes";
export * from "./domain/proxy";
export * from "./domain/servers";
export * from "./domain/settings";
export * from "./domain/system-users";
export * from "./domain/systemd";
export * from "./domain/terminal";
export * from "./domain/zfs";

// ---- Protocol plumbing -------------------------------------------------------
//
// The API is a map of typed operations. Each operation is exposed as
// `POST /<operationName>` with a JSON body of `data` and a JSON response of
// `response`. Live state is pushed over a WebSocket at `/events` as `ApiEvent`s.

/** One namespace's operations: `{ [op]: { data, response } }`. */
export type OperationMap = Record<string, { data: unknown; response: unknown }>;

/** Handlers for one namespace. */
export type ApiHandler<T> = {
    [K in keyof T]: T[K] extends { data: infer D; response: infer R } ? (data: D) => Promise<R> : never;
};

/**
 * Handlers for a whole protocol, nested by namespace — the shape
 * `composeApiHandlers` builds and the dispatcher flattens.
 *
 * There is no `handle` prefix any more. It existed to stop a request path
 * reaching an arbitrary property (`constructor`, `toString`, …) off the handler
 * object; the dispatcher now resolves through a `Map` built at boot, which has
 * no prototype to walk, so the guarantee comes from the lookup itself rather
 * than from decorating every method name.
 */
export type ApiHandlers<T> = {
    [N in keyof T]: ApiHandler<T[N]>;
};

// ---- Features ------------------------------------------------------------------
//
// Identity shared between a server-side Feature and its frontend counterpart. See
// doc/idea_feature_interface.md.

export interface FeatureDescriptor {
    id: string;              // stable key: config storage, dependsOn refs, task-kind
                              // prefixing, and the frontend's matching id. Never
                              // renamed, never shown to the user.
    name: string;
    description: string;
    experimental: boolean;
    dependsOn?: string[];     // other features' ids — inert metadata for now
    /** Host capability this feature needs to be usable on a given host. The
     *  feature still loads (it's per-host, not per-deployment); what changes is
     *  that the UI greys it out for hosts whose agent reported it unavailable. */
    requiresHostCapability?: HostCapability;
}


// ---- HTTP API operations -------------------------------------------------------

/**
 * The wire protocol: namespaces, each holding its own operations.
 *
 * A namespace key **is a feature id** — `docker` here is the same `docker` as
 * `features/docker/` and `descriptor.id` — so the URL space mirrors the feature
 * convention instead of merely resembling it, and `/api/<feature>/<operation>`
 * is the whole routing rule.
 *
 * Nesting is what removes the need for operations to carry their own domain in
 * their name: `docker/list`, not `dockerList`. Two features can no longer claim
 * the same name at all, since a name is only ever claimed inside one namespace
 * — where a flat map relied on a boot-time uniqueness check to notice.
 *
 * `composeApiHandlers` still proves at compile time that every namespace has a
 * feature and every operation in it has a handler; see
 * doc/idea_feature_convention.md §4.
 */
export interface CentralApiOperations {
    auth: AuthOperations;
    compose: ComposeOperations;
    dashboard: DashboardOperations;
    docker: DockerOperations;
    files: FilesOperations;
    network: NetworkOperations;
    oidc: OidcOperations;
    processes: ProcessesOperations;
    proxy: ProxyOperations;
    servers: ServersOperations;
    settings: SettingsOperations;
    "system-users": SystemUsersOperations;
    systemd: SystemdOperations;
    tasks: TasksOperations;
    zfs: ZfsOperations;
}

/** A namespace name — equivalently, the id of the feature that serves it. */
export type ApiNamespace = keyof CentralApiOperations;

/**
 * Every operation as its qualified `"<namespace>/<operation>"` wire name — the
 * path under {@link API_PREFIX}, and the key the permission registry classifies.
 */
export type ApiOperation = {
    [N in ApiNamespace]: `${N & string}/${keyof CentralApiOperations[N] & string}`;
}[ApiNamespace];

/** Split a qualified name back into its parts, for indexing the nested map. */
export type NamespaceOf<Q extends ApiOperation> = Q extends `${infer N}/${string}` ? N & ApiNamespace : never;

// ---- WebSocket events ----------------------------------------------------------

export type ApiEvent =
    | { kind: "init"; data: { servers: ServerEntry[]; metricsHistory: Record<string, MetricsSnapshot[]>; tasks: TaskRun[] } }
    | { kind: "serversUpdate"; data: ServerEntry[] }
    | { kind: "statusUpdate"; data: ServerStatus }
    | { kind: "metrics"; data: { serverId: string; snapshot: MetricsSnapshot } }
    // A run was created or changed status. Carries the full envelope.
    | { kind: "taskUpdate"; data: TaskRun }
    // New log lines appended for a run. Only fires for kinds that call ctx.log.
    | { kind: "taskLog"; data: { taskId: string; lines: TaskLogLine[] } };
