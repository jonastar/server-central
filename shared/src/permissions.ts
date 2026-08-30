/**
 * The authorization registry — every permission node, and everything it grants.
 *
 * Design: doc/idea_proxy_auth_gateway.md §1. One dotted namespace, split into two
 * halves with deliberately different rules.
 *
 * - `panel.*` is a **closed set**: {@link PANEL_PERMISSIONS} below is the whole
 *   of it, and each node names the operations, task kinds and pushed events it
 *   gates. Nothing outside this file decides what a node grants.
 * - `app.*` is **open**. Server Central cannot know another app's role names, so
 *   these are free strings: payload for the OIDC `groups` claim and matcher input
 *   for the reverse-proxy auth gate. Nothing in the control plane enforces them.
 *
 * Grants only. There are deliberately no negation entries (`-panel.terminal`):
 * they bring precedence rules that make an effective permission set impossible to
 * read off a user record, which is the property this whole model exists to have.
 *
 * **Why this lives in shared, not on each feature.** The operations and task
 * kinds it classifies are themselves declared centrally (`CentralApiOperations`,
 * `TaskSpec`) — a feature owns the *handler*, not the operation's existence. So
 * annotating that central registry centrally is the consistent placement, and it
 * buys two things a per-feature declaration couldn't: the web app can render what
 * a permission actually grants (it has the same map), and a node's description
 * sits next to what it describes. The cost is real and worth naming — reading
 * `zfs/feature.ts` no longer tells you what gates its operations. The node names
 * are meant to carry that weight.
 */

import type { CentralApiOperations, ApiEvent } from "./index";
import type { TaskSpec } from "./tasks";

type ApiOp = keyof CentralApiOperations;
type TaskKind = TaskSpec["kind"];
type EventKind = ApiEvent["kind"];

/** A node held by a user, or a pattern requiring one. Dotted, lowercase. */
export type Permission = string;

/**
 * What one API operation requires.
 *
 * `"public"` and `"authenticated"` are not nodes and never appear in a user's
 * grants — they're the two rungs below the permission system, listed in
 * {@link PUBLIC_OPS} and {@link SESSION_OPS}.
 */
export type OpRequirement = Permission | "public" | "authenticated";

interface PermissionDef {
    /** Short name for the permission tree in the UI. */
    label: string;
    /** What granting this actually lets someone do, in one sentence. Shown in
     *  the grants editor — the difference between a checkbox people tick
     *  carefully and one they tick to make the error go away. */
    description: string;
    /** API operations this node gates. */
    ops: readonly ApiOp[];
    /** Task kinds this node gates, on top of `panel.tasks.run` reaching the
     *  handler at all. `runTask` is one operation spanning a container restart
     *  and arbitrary shell, so the per-kind node is the real check. */
    tasks?: readonly TaskKind[];
    /** Events pushed over the websocket that this node gates. Pushing state is
     *  not a way around the permission the equivalent pull would need. */
    events?: readonly EventKind[];
    /**
     * How holding this node leads to root on a managed host, when that isn't
     * obvious from its name. The string is the explanation and its presence is
     * the mark — there's no separate boolean, because "which permissions are
     * secretly root" is a question whose only useful answer is *how*.
     *
     * This is a **different axis** from {@link PermissionDef.sensitive}, and
     * deliberately doesn't imply it. Sensitive means "a wildcard must not reach
     * this" and is about grants nobody intended. Escalation is a consequence of
     * a grant someone did intend: Server Central's agent runs as root, so most
     * ways of writing to a host are root-equivalent, and hiding that behind an
     * extra grant would make `panel.*` useless without making anyone safer. The
     * honest move is to say so where the choice is being made.
     */
    escalation?: string;
    /**
     * No wildcard reaches this node — not `panel.*`, not even `*`. It must be
     * granted by name.
     *
     * Wildcards bind late: `panel.*` granted today silently covers whatever is
     * added tomorrow. That's the point of a wildcard and it's fine for most of
     * the tree. It is not fine where "I didn't realise they had that" is an
     * incident rather than a surprise — arbitrary code execution on a host, or
     * the ability to grant permissions to oneself.
     */
    sensitive?: true;
}

// ---- The panel namespace -----------------------------------------------------
//
// Granularity is "a thing a person would think to grant" — roughly
// feature × (read | write | admin), not one node per operation. 80-odd operations
// behind ~30 nodes; a permission tree with one leaf per RPC would be unusable,
// and a tree nobody reads is its own kind of insecure.

export const PANEL_PERMISSIONS = {
    "panel.servers.read": {
        label: "View hosts",
        description: "See the fleet, host metrics and live status.",
        ops: ["getServers", "getMetricsHistory", "redetectHostCapabilities"],
        events: ["init", "serversUpdate", "statusUpdate", "metrics"],
    },
    "panel.servers.admin": {
        label: "Manage hosts",
        description: "Enrol new hosts, install and update agents, remove hosts from the fleet.",
        ops: ["deleteServer", "generateNodeInstallCommand", "probeInstallPath", "installNodeService"],
        tasks: ["update_agent"],
        escalation: "Installs and updates the agent, which runs as root, and hands out enrolment commands that let a new machine join the fleet.",
    },

    "panel.files.read": {
        label: "Browse files",
        description: "Browse directories and read the contents of any file on any host.",
        ops: ["listDir", "readFile"],
        escalation: "Reads every path as root — private keys, /etc/shadow, and Server Central's own data directory, which holds session tokens and the agent enrolment token. Reading those tokens is enough to act as another user.",
    },
    "panel.mounts.read": {
        label: "View mounts & devices",
        description: "See mounted filesystems and mappable devices — an inventory of the host, with no file contents.",
        ops: ["getMounts", "listHostDevices"],
    },
    "panel.files.write": {
        label: "Modify files",
        description: "Create, edit, rename, upload and delete files anywhere on any host.",
        ops: ["writeFile", "uploadFile", "createDir", "deletePath", "renamePath"],
        escalation: "Writes every path as root. A file dropped in /etc/sudoers.d, ~/.ssh/authorized_keys or a systemd unit is a root shell.",
    },

    "panel.docker.read": {
        label: "View containers",
        description: "See containers, images, volumes and their logs.",
        ops: ["dockerList", "dockerContainerLogs", "dockerOverview", "dockerContainerInspect", "dockerVolumeInspect", "dockerImageDefaults"],
    },
    "panel.docker.control": {
        label: "Control containers",
        description: "Start, stop, restart, pause and remove existing containers and stacks.",
        ops: [],
        tasks: ["docker_stack_action", "docker_container_action"],
    },
    "panel.docker.deploy": {
        label: "Deploy stacks",
        description: "Bring compose stacks up and down, and pull images.",
        ops: [],
        tasks: ["docker_compose_action", "docker_image_pull"],
        escalation: "Bringing a stack up instantiates whatever its compose file declares — a bind mount of /, --privileged, or the docker socket itself. Paired with permission to edit that file, it is root on the host.",
    },
    "panel.docker.prune": {
        label: "Remove images & volumes",
        description: "Delete images and volumes, including data that isn't backed up anywhere else.",
        ops: ["dockerVolumeRemove", "dockerImageAction"],
    },
    "panel.docker.exec": {
        label: "Run commands in containers",
        description: "Execute arbitrary commands inside any container.",
        ops: ["dockerContainerExec"],
        escalation: "A shell in a container that mounts host paths, or runs privileged, is a shell on the host.",
        sensitive: true,
    },

    "panel.compose.read": {
        label: "View compose stacks",
        description: "See registered stacks, their services, status and logs.",
        ops: ["listComposeStacks", "listHostComposeStacks", "readHostComposeStacks", "getComposeStackStatus", "getComposeStackLogs", "validateComposeContent", "detectComposeStack"],
    },
    "panel.compose.write": {
        label: "Manage compose stacks",
        description: "Create, import and delete stacks, and edit their compose files.",
        ops: ["createComposeStack", "importComposeStack", "deleteComposeStack"],
        escalation: "A compose file is a container definition: mounting / into a container, or granting it the docker socket, makes it root on the host. This is the permission that writes them.",
    },

    "panel.systemd.read": {
        label: "View services",
        description: "See systemd units, their state, logs and unit files.",
        ops: ["systemdList", "systemdServiceLogs", "systemdUnitFile"],
    },
    "panel.systemd.write": {
        label: "Control services",
        description: "Start, stop, restart and reload systemd units.",
        ops: [],
        tasks: ["service_action"],
    },

    "panel.zfs.read": {
        label: "View ZFS",
        description: "See pools, datasets, snapshots and available disks.",
        ops: ["getZfsState", "getZfsDatasets", "getZfsSnapshots", "getZfsBlockDevices"],
    },
    "panel.zfs.write": {
        label: "Manage datasets & snapshots",
        description: "Create and destroy datasets and snapshots, roll back, clone, scrub.",
        ops: ["setDatasetProperty"],
        tasks: ["zfs_scrub", "zfs_dataset_create", "zfs_dataset_destroy", "zfs_snapshot_create", "zfs_snapshot_rollback", "zfs_snapshot_destroy", "zfs_snapshot_clone"],
    },
    "panel.zfs.admin": {
        label: "Pool & vdev surgery",
        description: "Create, destroy, import and export pools, add vdevs, replace devices. The highest blast radius in the system — a mistake here loses data irrecoverably.",
        ops: [],
        tasks: ["zfs_pool_create", "zfs_pool_destroy", "zfs_pool_import", "zfs_pool_export", "zfs_vdev_add", "zfs_device_replace"],
        escalation: "Importing a pool mounts filesystems chosen by whoever created it, at mountpoints it chooses.",
    },

    "panel.network.read": {
        label: "View network",
        description: "See interfaces and addresses, and run WAN address probes.",
        ops: ["getNetworkInfo"],
        tasks: ["find_wan_ip"],
    },
    "panel.processes.read": {
        label: "View processes",
        description: "See the process list on any host.",
        ops: ["getProcesses"],
    },

    "panel.terminal": {
        label: "Open terminals",
        description: "Open a shell on any host, as the mapped system user (or root if unmapped and privileged).",
        ops: [],
        escalation: "An unmapped holder gets the agent's own shell, which is root.",
        sensitive: true,
    },
    "panel.exec": {
        label: "Run host commands",
        description: "Run arbitrary shell commands on any host as a task. Equivalent to terminal access.",
        ops: [],
        tasks: ["cmd"],
        escalation: "Runs any command as the agent's user, which is root.",
        sensitive: true,
    },

    "panel.systemUsers.read": {
        label: "View host accounts",
        description: "See OS accounts on hosts and how they map to control-panel users.",
        ops: ["systemUsersList", "systemUserHostStatus"],
    },
    "panel.systemUsers.admin": {
        label: "Manage host accounts",
        description: "Create OS accounts on hosts and change their group membership — including groups that grant root-equivalent access.",
        ops: ["systemUserCreate", "systemUserSetGroups"],
        escalation: "Adding an account to the sudo or docker group is root, and both groups are assignable here.",
        sensitive: true,
    },

    "panel.tasks.read": {
        label: "View tasks",
        description: "See task history, results and live logs.",
        ops: ["listTasks", "getTask", "getTaskLogs"],
        events: ["taskUpdate", "taskLog"],
    },
    "panel.tasks.run": {
        label: "Run tasks",
        description: "Start task runs. Each kind needs its own permission on top of this.",
        ops: ["runTask"],
    },

    "panel.dashboard.read": {
        label: "View host dashboards",
        description: "See the widget layout on a host's overview.",
        ops: ["getHostDashboard"],
    },
    "panel.dashboard.write": {
        label: "Arrange host dashboards",
        description: "Add, remove and rearrange host overview widgets for everyone.",
        ops: ["setHostDashboard", "resetHostDashboard"],
    },

    "panel.proxy.read": {
        label: "View reverse proxy",
        description: "See proxy configuration, routes and status.",
        ops: ["getProxyState"],
    },
    "panel.proxy.admin": {
        label: "Manage reverse proxy",
        description: "Configure the proxy, deploy it, and add or remove routes — which decides what is exposed to the internet.",
        ops: ["setProxyConfig", "deployProxy", "removeProxy", "createProxyRoute", "updateProxyRoute", "deleteProxyRoute", "applyProxyConfig"],
        escalation: "Deploying the proxy runs a container with mounted volumes on the chosen node, and routes decide what is reachable from the internet.",
    },

    "panel.settings.read": {
        label: "View settings",
        description: "See control-plane configuration and update status.",
        ops: ["getConfig", "getControlPlaneStatus"],
    },
    "panel.settings.admin": {
        label: "Change settings",
        description: "Edit the primary URL, agent domain, allowed origins and trusted proxies, and update the control plane itself.",
        ops: ["setDomain", "setPrimaryUrl", "setAllowedOrigins", "setTrustedProxies", "updateControlPlane"],
        tasks: ["debug_fake"],
        escalation: "Replaces the control plane's own binary, and edits the trusted-proxy list that decides which client addresses are believed.",
    },

    "panel.oidc.read": {
        label: "View SSO clients",
        description: "See registered OpenID Connect relying parties.",
        ops: ["listOidcClients"],
    },
    "panel.oidc.admin": {
        label: "Manage SSO clients",
        description: "Register and remove relying parties, and issue their client secrets.",
        ops: ["createOidcClient", "deleteOidcClient"],
    },

    "panel.roles.read": {
        label: "View roles",
        description: "See the roles defined here and which permissions each one grants.",
        ops: ["listRoles"],
    },
    "panel.roles.admin": {
        label: "Define roles",
        description: "Create, edit and delete roles. Anyone who can define a role can define one that grants everything, so this is effectively the ability to grant oneself any permission.",
        ops: ["createRole", "updateRole", "deleteRole", "resetRole"],
        escalation: "A role granting everything can be defined and then assigned by anyone who can also assign roles.",
        sensitive: true,
    },

    "panel.users.read": {
        label: "View accounts",
        description: "See control-panel accounts, their roles and their active sessions.",
        ops: ["listUsers", "getUserDetail"],
    },
    "panel.users.admin": {
        label: "Manage accounts",
        description: "Create and delete accounts, set passwords, assign roles and grant permissions — including granting permissions to oneself.",
        ops: ["createUser", "deleteUser", "setUserRoles", "revokeUserSession", "adminSetPassword", "setUserSystemUser", "setUserPermissions"],
        escalation: "Granting oneself any permission is one edit away, and every root-equivalent permission is reachable from there.",
        sensitive: true,
    },
} as const satisfies Record<string, PermissionDef>;

export type PanelPermission = keyof typeof PANEL_PERMISSIONS;

/**
 * The registry widened to the interface.
 *
 * `as const satisfies` above keeps every literal — which is what the
 * exhaustiveness derivation below needs — but it also means the union of entries
 * has no `tasks`/`events`/`sensitive` member, since not every entry declares one.
 * Runtime iteration goes through this view; type-level derivation goes through
 * the literal. Same object either way.
 */
const DEFS: Record<PanelPermission, PermissionDef> = PANEL_PERMISSIONS;

/** One node's full definition, for the UI's permission tree. */
export function permissionDef(id: PanelPermission): PermissionDef {
    return DEFS[id];
}

/** Every node id, for iteration and for the UI's tree. */
export const PANEL_PERMISSION_IDS = Object.keys(PANEL_PERMISSIONS) as PanelPermission[];

/** Callable with no session at all: first-run setup and login. */
export const PUBLIC_OPS = ["getAuthState", "setupOwner", "login"] as const satisfies readonly ApiOp[];

/** Callable by any signed-in user regardless of grants — the session's own
 *  bookkeeping, plus the OIDC front-channel, which is about the caller's own
 *  identity rather than any control-plane resource. */
export const SESSION_OPS = ["logout", "me", "getOidcAuthorizeRequest", "completeOidcAuthorize"] as const satisfies readonly ApiOp[];

// ---- Exhaustiveness ----------------------------------------------------------
//
// Inverting the mapping (node → ops, rather than op → node) is what lets the UI
// explain a permission, and it's what would otherwise lose the guarantee that
// every operation is classified: a `Record<ApiOp, …>` was total by construction,
// a list of names is not. These derived checks put that back. An operation or
// task kind nobody classified makes the assignment below fail, naming it.

type ClassifiedOp =
    | (typeof PANEL_PERMISSIONS)[PanelPermission]["ops"][number]
    | (typeof PUBLIC_OPS)[number]
    | (typeof SESSION_OPS)[number];

type UnclassifiedOps = Exclude<ApiOp, ClassifiedOp>;

/** Fails to compile, naming the operations, if any API operation has no
 *  permission, and isn't public or session-level. */
const _opsAreExhaustive: UnclassifiedOps extends never ? true : UnclassifiedOps = true;
void _opsAreExhaustive;

// Written as a conditional rather than an indexed access, because entries that
// declare no `tasks` have no such property to index into.
type TasksOf<T> = T extends { tasks: readonly (infer K)[] } ? K : never;
type ClassifiedTask = TasksOf<(typeof PANEL_PERMISSIONS)[PanelPermission]>;
type UnclassifiedTasks = Exclude<TaskKind, ClassifiedTask>;

/** Same, for task kinds. An unclassified kind would be runnable by anyone
 *  holding `panel.tasks.run` — which for `cmd` is arbitrary shell. */
const _tasksAreExhaustive: UnclassifiedTasks extends never ? true : UnclassifiedTasks = true;
void _tasksAreExhaustive;

// ---- Derived lookups ---------------------------------------------------------
//
// Built by inverting the registry once at module load. These are what the
// dispatcher and the task gate actually read; the registry above is the source.

function buildOpRequirements(): Record<ApiOp, OpRequirement> {
    const out = {} as Record<ApiOp, OpRequirement>;
    for (const op of PUBLIC_OPS) {
        out[op] = "public";
    }
    for (const op of SESSION_OPS) {
        out[op] = "authenticated";
    }
    for (const id of PANEL_PERMISSION_IDS) {
        for (const op of DEFS[id].ops) {
            if (out[op]) {
                throw new Error(`Operation "${op}" is classified twice: "${out[op]}" and "${id}"`);
            }
            out[op] = id;
        }
    }
    return out;
}

function buildTaskRequirements(): Record<TaskKind, Permission> {
    const out = {} as Record<TaskKind, Permission>;
    for (const id of PANEL_PERMISSION_IDS) {
        for (const kind of DEFS[id].tasks ?? []) {
            if (out[kind]) {
                throw new Error(`Task kind "${kind}" is classified twice: "${out[kind]}" and "${id}"`);
            }
            out[kind] = id;
        }
    }
    return out;
}

function buildEventRequirements(): Record<EventKind, Permission> {
    const out = {} as Record<EventKind, Permission>;
    for (const id of PANEL_PERMISSION_IDS) {
        for (const kind of DEFS[id].events ?? []) {
            if (out[kind]) {
                throw new Error(`Event "${kind}" is classified twice: "${out[kind]}" and "${id}"`);
            }
            out[kind] = id;
        }
    }
    return out;
}

/**
 * What each operation requires. The dispatcher's lookup.
 *
 * Double-classification is a throw rather than a type error: two nodes both
 * listing an operation is not something `Exclude` can see, and the ambiguity
 * ("which of these does the user need?") has no safe default.
 */
export const OP_REQUIREMENTS: Record<ApiOp, OpRequirement> = buildOpRequirements();

/** What each task kind requires, on top of `panel.tasks.run`. */
export const TASK_KIND_PERMISSIONS: Record<TaskKind, Permission> = buildTaskRequirements();

/** What each pushed event requires. */
export const EVENT_PERMISSIONS: Record<EventKind, Permission> = buildEventRequirements();

/** Nodes no wildcard reaches — see {@link PermissionDef.sensitive}. */
export const SENSITIVE_PERMISSIONS: readonly Permission[] =
    PANEL_PERMISSION_IDS.filter((id) => DEFS[id].sensitive);

// ---- Matching ----------------------------------------------------------------

/**
 * Whether one held node satisfies one required node.
 *
 * The whole rule: equal, or the held one ends in `.*` and the required one sits
 * under that prefix. `*` alone matches everything.
 *
 * Prefix wildcards only — suffix and mid-pattern globs (`*.admin`) are
 * deliberately unsupported. They turn this from a prefix test into a glob engine,
 * and turn "what does this user hold" from an enumeration into a search over the
 * whole registry. `.read`/`.write`/`.admin`/`.user` are a naming *convention*
 * across features and apps, not something this function knows about.
 */
export function permissionMatches(held: Permission, required: Permission): boolean {
    if (held === required) {
        return true;
    }
    if (held === "*") {
        return true;
    }
    return held.endsWith(".*") && required.startsWith(held.slice(0, -1));
}

/**
 * Whether a permission set satisfies a required node.
 *
 * Sensitive nodes ignore wildcards entirely and need an exact grant. Everything
 * else goes through {@link permissionMatches}.
 */
export function hasPermission(held: readonly Permission[], required: Permission): boolean {
    if (SENSITIVE_PERMISSIONS.includes(required)) {
        return held.includes(required);
    }
    return held.some((h) => permissionMatches(h, required));
}

/**
 * Whether two patterns describe overlapping sets — i.e. whether some concrete
 * node exists that both would match.
 *
 * {@link hasPermission} is deliberately one-directional: an operation requires a
 * *concrete* node, and holding `panel.files.read` must never satisfy a required
 * `panel.files.write`. The proxy auth gate asks a different question, because its
 * requirements are patterns: does anything this user holds fall under
 * `app.immich.*`? A held `app.immich.admin` should pass that, and one-directional
 * matching says no.
 *
 * Symmetry is the right answer for gate-style questions and the wrong one for
 * operation gating, which is why they stay two functions. Do not "simplify" the
 * operation gate onto this one: a pattern accidentally declared as an operation's
 * requirement would then be satisfied by anything overlapping it.
 */
export function permissionOverlaps(a: Permission, b: Permission): boolean {
    return permissionMatches(a, b) || permissionMatches(b, a);
}

/** Whether a permission set satisfies *any* of several required patterns — what
 *  the proxy auth gate's `requirePermissions` asks. An empty list means "no
 *  specific node required", not "nothing is allowed": a route group that names no
 *  permission is open to every signed-in user, which is the sane default for a
 *  group whose whole job is "keep strangers out". */
export function hasAnyPermission(held: readonly Permission[], required: readonly Permission[]): boolean {
    if (required.length === 0) {
        return true;
    }
    return required.some((r) => (SENSITIVE_PERMISSIONS.includes(r)
        ? held.includes(r)
        : held.some((h) => permissionOverlaps(h, r))));
}

/** Shape check for a node a human typed: dotted lowercase segments, optionally
 *  ending in `.*`, or the bare `*`. Says nothing about whether it exists — only
 *  `panel.*` has a registry to check against, and `app.*` deliberately doesn't. */
export function isValidPermission(value: string): boolean {
    return value === "*" || /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*(\.\*)?$/i.test(value);
}

// ---- Roles ---------------------------------------------------------------------
//
// Permissions are what gets enforced; a role is a **named, editable bundle** of
// them, because a Users screen with thirty checkboxes is one nobody configures
// correctly. A user holds any number of roles and their grants union together —
// which needs no precedence rules at all, precisely because the model is
// grant-only. "No roles" is the floor: an account that may sign in and hold
// `app.*` grants for SSO and the reverse-proxy gate, while reaching nothing in
// the control plane.
//
// Roles live in the control plane's own store, not here. The definitions below
// are **seeds**: written once on first run and owned by the installation from
// then on. A later release adding a permission node does not silently widen an
// existing role — the fail-closed direction, and the same reasoning as sensitive
// nodes not being covered by wildcards. The cost is that a new node reaches no
// role until someone adds it, which is what `unassignedPermissions` surfaces.

export interface RoleDef {
    /** Stable key, referenced by user records. Never renamed. */
    id: string;
    name: string;
    description: string;
    permissions: Permission[];
    /** Came from {@link SEED_ROLES}. Editable and deletable like any other — the
     *  flag is provenance for the UI, not protection. */
    seeded?: boolean;
}

/**
 * The roles a fresh installation starts with.
 *
 * Named "Control panel …" because the permission namespace has two halves: these
 * grant `panel.*`, and an installation will grow roles that grant `app.*` for
 * people who never touch the control panel at all.
 */
export const SEED_ROLES: readonly RoleDef[] = [
    {
        id: "viewer",
        name: "Control panel viewer",
        description: "Read-only across the fleet. Can look at anything, change nothing.",
        seeded: true,
        permissions: [
            "panel.compose.read",
            "panel.dashboard.read",
            "panel.docker.read",
            // Deliberately not panel.files.read: reading any path as root
            // includes Server Central's own session and agent tokens, which
            // makes "read-only across the fleet" an escalation. A viewer who
            // genuinely needs the file browser gets it as an explicit grant.
            "panel.mounts.read",
            "panel.network.read",
            "panel.processes.read",
            "panel.servers.read",
            "panel.systemd.read",
            "panel.tasks.read",
            "panel.zfs.read",
        ],
    },
    {
        id: "operator",
        name: "Control panel operator",
        description: "Day-to-day operations: start and stop things, edit files, manage snapshots. No shell, no host enrolment, no settings.",
        seeded: true,
        permissions: [
            "panel.compose.read",
            "panel.compose.write",
            "panel.dashboard.read",
            "panel.dashboard.write",
            "panel.docker.control",
            "panel.docker.deploy",
            "panel.docker.prune",
            "panel.docker.read",
            "panel.files.read",
            "panel.files.write",
            "panel.mounts.read",
            "panel.network.read",
            "panel.processes.read",
            "panel.servers.read",
            "panel.systemd.read",
            "panel.systemd.write",
            "panel.tasks.read",
            "panel.tasks.run",
            "panel.zfs.read",
            "panel.zfs.write",
        ],
    },
    {
        id: "admin",
        name: "Control panel admin",
        description: "Everything an operator can do, plus shells, host enrolment and settings. Not account or role management — that stays with the owner.",
        seeded: true,
        permissions: [
            "panel.compose.read",
            "panel.compose.write",
            "panel.dashboard.read",
            "panel.dashboard.write",
            "panel.docker.control",
            "panel.docker.deploy",
            "panel.docker.exec",
            "panel.docker.prune",
            "panel.docker.read",
            "panel.exec",
            "panel.files.read",
            "panel.files.write",
            "panel.mounts.read",
            "panel.network.read",
            "panel.oidc.admin",
            "panel.oidc.read",
            "panel.processes.read",
            "panel.proxy.admin",
            "panel.proxy.read",
            "panel.roles.read",
            "panel.servers.admin",
            "panel.servers.read",
            "panel.settings.admin",
            "panel.settings.read",
            "panel.systemUsers.admin",
            "panel.systemUsers.read",
            "panel.systemd.read",
            "panel.systemd.write",
            "panel.tasks.read",
            "panel.tasks.run",
            "panel.terminal",
            "panel.users.read",
            "panel.zfs.read",
            "panel.zfs.write",
        ],
    },
];

/** The shipped definition for a seeded role id, or null for a custom role. */
export function seedRoleFor(id: string): RoleDef | null {
    return SEED_ROLES.find((r) => r.id === id) ?? null;
}

/**
 * Whether a seeded role still matches what shipped.
 *
 * Drift is expected — that's the point of seeding rather than hardcoding — but
 * it's worth showing, because the two reasons a role differs from its default
 * look identical from the outside: someone edited it, or a later release added a
 * permission this installation never picked up. Resetting resolves both.
 *
 * Permissions compare as sets: reordering them in the editor isn't a change.
 */
export function roleMatchesSeed(role: RoleDef): boolean {
    const seed = seedRoleFor(role.id);
    if (!seed) {
        return false;
    }
    return role.name === seed.name
        && role.description === seed.description
        && role.permissions.length === seed.permissions.length
        && [...role.permissions].sort().join("\u0000") === [...seed.permissions].sort().join("\u0000");
}

/**
 * Declared nodes that no role grants.
 *
 * Seeded-and-editable roles mean a permission added in a later release reaches
 * nobody until someone adds it — safe, but invisible. This is the other half of
 * that bargain: the Roles screen can say "3 permissions are in no role" so a new
 * capability is discovered deliberately rather than never.
 */
export function unassignedPermissions(roles: readonly RoleDef[]): PanelPermission[] {
    const granted = new Set(roles.flatMap((r) => r.permissions));
    return PANEL_PERMISSION_IDS.filter((id) => !granted.has(id));
}

/** A user as the permission system sees them. The control plane's `UserInfo`
 *  satisfies this; so does anything else that needs checking. */
export interface PermissionSubject {
    /** The owner bypasses every check — see {@link userCan}. */
    isOwner: boolean;
    permissions: readonly Permission[];
}

/**
 * Everything a user effectively holds: the union of their roles, plus ad-hoc
 * grants on top.
 *
 * The owner's set is reported as `["*"]` for display and for the OIDC claim, but
 * nothing enforcing anything should read it — {@link userCan} short-circuits on
 * `isOwner`, because `*` deliberately does not cover sensitive nodes.
 */
export function effectivePermissions(
    isOwner: boolean,
    roles: readonly RoleDef[],
    extra: readonly Permission[] = [],
): Permission[] {
    const out: Permission[] = [];
    if (isOwner) {
        // `*` stands for the bypass in the UI and nothing reads it for
        // enforcement. Ad-hoc grants still merge on top, because `app.*` nodes
        // are not something the bypass covers: they're claims for other systems,
        // and owning the control plane deliberately does not make someone an
        // admin inside every app connected to it. An owner who wants a role in
        // Immich grants it to themselves like anyone else.
        out.push("*");
    }
    for (const p of [...(isOwner ? [] : roles.flatMap((r) => r.permissions)), ...extra]) {
        if (!out.includes(p)) {
            out.push(p);
        }
    }
    return out;
}

/** The authorization check. Every gate in the control plane goes through this,
 *  so the owner bypass lives in exactly one place. */
export function userCan(user: PermissionSubject | null | undefined, required: Permission): boolean {
    if (!user) {
        return false;
    }
    return user.isOwner || hasPermission(user.permissions, required);
}

/** Whether this user may run this kind — both gates, in the order the server
 *  applies them. The web app's guard on every task-running control. */
export function canRunTask(user: PermissionSubject | null | undefined, kind: TaskKind): boolean {
    return userCan(user, "panel.tasks.run") && userCan(user, TASK_KIND_PERMISSIONS[kind]);
}

/**
 * What a socket must hold before a pushed event may reach it.
 *
 * Pushing state over the events websocket is not a way around the permission the
 * equivalent pull would need: `serversUpdate` carries the same inventory as
 * `getServers`, and `taskUpdate` the same runs as `listTasks`.
 */
export function eventPermission(kind: EventKind): Permission {
    return EVENT_PERMISSIONS[kind];
}

/**
 * The escalation notes among a set of permissions, keyed by node.
 *
 * Used to say "this role grants root on managed hosts, here's how" at the point
 * someone is assembling it — the individual marks are easy to scroll past, and
 * the property that matters is a property of the whole bundle.
 */
export function escalationsIn(permissions: readonly Permission[]): Array<{ id: PanelPermission; why: string }> {
    return PANEL_PERMISSION_IDS
        .filter((id) => permissions.includes(id) && DEFS[id].escalation)
        .map((id) => ({ id, why: DEFS[id].escalation as string }));
}
