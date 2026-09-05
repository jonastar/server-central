import { describe, expect, test } from "bun:test";
import {
    EVENT_PERMISSIONS,
    OP_REQUIREMENTS,
    PANEL_PERMISSIONS,
    PANEL_PERMISSION_IDS,
    SEED_ROLES,
    TASK_KIND_PERMISSIONS,
    canRunTask,
    effectivePermissions,
    permissionDef,
    userCan,
    unassignedPermissions,
    type PanelPermission,
    type RoleDef,
    type TaskSpec,
} from "@central/shared";

// The registry is a constant now, not something composed from the feature list —
// which is most of the point of moving it to shared. Exhaustiveness (every
// operation and task kind classified) is proven at compile time by the derived
// `Exclude` checks in permissions.ts; what's worth asserting at runtime is that
// the derived lookups are coherent and that each role reaches what it should.

describe("registry integrity", () => {
    test("every operation requirement is a declared node or one of the two rungs below", () => {
        for (const [op, required] of Object.entries(OP_REQUIREMENTS)) {
            if (required === "public" || required === "authenticated") {
                continue;
            }
            expect(PANEL_PERMISSION_IDS, `${op} requires an undeclared node "${required}"`).toContain(required as PanelPermission);
        }
    });

    test("every task and event requirement is a declared node", () => {
        for (const required of [...Object.values(TASK_KIND_PERMISSIONS), ...Object.values(EVENT_PERMISSIONS)]) {
            expect(PANEL_PERMISSION_IDS).toContain(required as PanelPermission);
        }
    });

    test("no node is dead weight — each one gates something", () => {
        // A node granting nothing reads as protection that isn't attached to
        // anything. `panel.terminal` is the exception: it gates a WebSocket
        // upgrade, checked in index.ts rather than through any of these maps.
        for (const id of PANEL_PERMISSION_IDS) {
            const def = permissionDef(id);
            const grants = def.ops.length + (def.tasks?.length ?? 0) + (def.events?.length ?? 0);
            expect(grants > 0 || id === "panel.terminal", `"${id}" grants nothing`).toBe(true);
        }
    });

    test("nothing is classified twice", () => {
        // The builders throw on a duplicate, so importing the module at all is
        // most of this test; the inverse check catches the subtler version where
        // two nodes list the same op and one silently wins.
        const seen = new Map<string, string>();
        for (const id of PANEL_PERMISSION_IDS) {
            for (const op of permissionDef(id).ops) {
                expect(seen.has(op), `"${op}" is claimed by both "${seen.get(op)}" and "${id}"`).toBe(false);
                seen.set(op, id);
            }
        }
    });

    test("every node carries a label and a description the UI can show", () => {
        // These are the whole reason the registry is shaped node-first; an entry
        // without them is a checkbox nobody can make an informed decision about.
        for (const id of PANEL_PERMISSION_IDS) {
            const def = permissionDef(id);
            expect(def.label.length, `"${id}" has no label`).toBeGreaterThan(0);
            expect(def.description.length, `"${id}" has no description`).toBeGreaterThan(10);
            expect(def.description.trim().endsWith("."), `"${id}" description should be a sentence`).toBe(true);
        }
    });

    test("seed roles only name declared nodes", () => {
        for (const role of SEED_ROLES) {
            for (const node of role.permissions) {
                expect(PANEL_PERMISSION_IDS, `role "${role.id}" names an undeclared node "${node}"`).toContain(node as PanelPermission);
            }
        }
    });

    test("the seeds between them cover every node except the deliberate holdouts", () => {
        // Seeded roles are editable, so a node added later reaches nobody until
        // someone adds it — safe, but invisible. `unassignedPermissions` is what
        // makes it visible; this asserts the shipped seeds start out with only
        // the holdouts unassigned, so a new node stands out immediately.
        expect(unassignedPermissions(SEED_ROLES).sort()).toEqual([
            "panel.roles.admin",
            "panel.users.admin",
            "panel.zfs.admin",
        ]);
    });

    test("only the three first-run/login operations are public", () => {
        const publicOps = Object.entries(OP_REQUIREMENTS).filter(([, r]) => r === "public").map(([op]) => op).sort();
        expect(publicOps).toEqual(["auth/getState", "auth/login", "auth/setupOwner"]);
    });

    test("only session-shaped operations skip the permission check", () => {
        const anyUser = Object.entries(OP_REQUIREMENTS).filter(([, r]) => r === "authenticated").map(([op]) => op).sort();
        expect(anyUser).toEqual(["auth/logout", "auth/me", "oidc/completeAuthorize", "oidc/getAuthorizeRequest"]);
    });
});

describe("what each role can actually reach", () => {
    const OWNER = { isOwner: true, permissions: effectivePermissions(true, []) };

    function seeded(...ids: string[]) {
        const roles = ids.map((id) => SEED_ROLES.find((r) => r.id === id)).filter((r): r is RoleDef => !!r);
        expect(roles).toHaveLength(ids.length);
        return { isOwner: false, permissions: effectivePermissions(false, roles) };
    }

    function user(role: string) {
        return role === "owner" ? OWNER : role === "none" ? { isOwner: false, permissions: [] } : seeded(role);
    }

    function allowedOps(role: string): string[] {
        return Object.entries(OP_REQUIREMENTS)
            .filter(([, r]) => r !== "public" && r !== "authenticated" && userCan(user(role), r))
            .map(([op]) => op)
            .sort();
    }

    function runnable(role: string): string[] {
        return Object.keys(TASK_KIND_PERMISSIONS)
            .filter((kind) => canRunTask(user(role), kind as TaskSpec["kind"]))
            .sort();
    }

    test("the owner reaches every operation", () => {
        const gated = Object.entries(OP_REQUIREMENTS).filter(([, r]) => r !== "public" && r !== "authenticated");
        expect(allowedOps("owner")).toHaveLength(gated.length);
    });

    test("holding several roles unions their grants", () => {
        // The whole reason multiple roles need no precedence rules: the model is
        // grant-only, so a union is the entire semantics.
        const both = seeded("viewer", "operator");
        const operatorOnly = seeded("operator");
        for (const node of operatorOnly.permissions) {
            expect(both.permissions).toContain(node);
        }
        expect(userCan(both, "panel.files.write")).toBe(true);
        expect(userCan(both, "panel.terminal")).toBe(false);
    });

    test("`none` reaches no operation, task or event", () => {
        expect(allowedOps("none")).toEqual([]);
        expect(runnable("none")).toEqual([]);
        for (const required of Object.values(EVENT_PERMISSIONS)) {
            expect(userCan(user("none"), required)).toBe(false);
        }
    });

    test("an app-only account stays out regardless of its app grants", () => {
        const grandma = { isOwner: false, permissions: effectivePermissions(false, [], ["app.immich.user", "app.*"]) };
        for (const required of Object.values(OP_REQUIREMENTS)) {
            if (required === "public" || required === "authenticated") {
                continue;
            }
            expect(userCan(grandma, required)).toBe(false);
        }
    });

    test("a viewer reads but cannot write, exec or administer", () => {
        const viewer = allowedOps("viewer");
        expect(viewer).toContain("docker/list");
        expect(viewer).toContain("files/getMounts");
        for (const denied of ["files/write", "files/delete", "docker/containerExec", "proxy/setConfig", "tasks/run", "auth/createUser", "settings/updateControlPlane"]) {
            expect(viewer, `viewer must not reach ${denied}`).not.toContain(denied);
        }
        expect(runnable("viewer")).toEqual([]);
    });

    test("a viewer cannot read file contents", () => {
        // "Read-only across the fleet" must not mean "reads every secret on
        // every host". readFile reaches private keys and Server Central's own
        // session and agent tokens, so it's an explicit grant, not a tier.
        const viewer = allowedOps("viewer");
        expect(viewer).not.toContain("files/read");
        expect(viewer).not.toContain("files/listDir");
    });

    test("an operator acts but does not administer", () => {
        const operator = allowedOps("operator");
        expect(operator).toContain("files/write");
        expect(operator).toContain("tasks/run");
        for (const denied of ["docker/containerExec", "proxy/setConfig", "servers/installService", "auth/createUser", "settings/setTrustedProxies"]) {
            expect(operator, `operator must not reach ${denied}`).not.toContain(denied);
        }
        const ops = runnable("operator");
        for (const granted of ["docker_container_action", "docker_compose_action", "service_action", "zfs_snapshot_create", "zfs_scrub"]) {
            expect(ops, `operator should run ${granted}`).toContain(granted);
        }
        for (const denied of ["cmd", "update_agent", "zfs_pool_destroy", "zfs_vdev_add", "debug_fake"]) {
            expect(ops, `operator must not run ${denied}`).not.toContain(denied);
        }
    });

    test("an admin administers hosts but not accounts", () => {
        const admin = allowedOps("admin");
        for (const granted of ["servers/installService", "proxy/setConfig", "docker/containerExec", "settings/setTrustedProxies", "auth/listUsers"]) {
            expect(admin, `admin should reach ${granted}`).toContain(granted);
        }
        for (const denied of ["auth/createUser", "auth/deleteUser", "updateUserRole", "auth/setUserPermissions", "auth/adminSetPassword"]) {
            expect(admin, `admin must not reach ${denied}`).not.toContain(denied);
        }
        expect(runnable("admin")).toContain("cmd");
        expect(runnable("admin")).toContain("update_agent");
    });

    test("pool and vdev surgery stays owner-only by default, but is now grantable", () => {
        for (const kind of ["zfs_pool_create", "zfs_pool_destroy", "zfs_pool_import", "zfs_pool_export", "zfs_vdev_add", "zfs_device_replace"] as const) {
            expect(TASK_KIND_PERMISSIONS[kind]).toBe("panel.zfs.admin");
            expect(runnable("admin")).not.toContain(kind);
            expect(runnable("owner")).toContain(kind);
        }
        const trusted = { isOwner: false, permissions: effectivePermissions(false, [SEED_ROLES[1]], ["panel.zfs.admin"]) };
        expect(canRunTask(trusted, "zfs_pool_destroy")).toBe(true);
    });

    test("arbitrary shell is not reachable through a wildcard", () => {
        expect(TASK_KIND_PERMISSIONS.cmd).toBe("panel.exec");
        const wild = { isOwner: false, permissions: effectivePermissions(false, [SEED_ROLES[1]], ["panel.*"]) };
        expect(canRunTask(wild, "cmd")).toBe(false);
    });

    test("the role ladder is monotonic over real operations and tasks", () => {
        const ladder = ["none", "viewer", "operator", "admin"];
        for (let i = 1; i < ladder.length; i++) {
            for (const op of allowedOps(ladder[i - 1])) {
                expect(allowedOps(ladder[i]), `${ladder[i]} should reach everything ${ladder[i - 1]} does`).toContain(op);
            }
            for (const kind of runnable(ladder[i - 1])) {
                expect(runnable(ladder[i])).toContain(kind);
            }
        }
    });
});

describe("pushed events are gated like the equivalent pull", () => {
    test("fleet events need what getServers needs, task events what listTasks needs", () => {
        expect(EVENT_PERMISSIONS.serversUpdate).toBe(OP_REQUIREMENTS["servers/list"] as string);
        expect(EVENT_PERMISSIONS.statusUpdate).toBe(OP_REQUIREMENTS["servers/list"] as string);
        expect(EVENT_PERMISSIONS.metrics).toBe(OP_REQUIREMENTS["servers/getMetricsHistory"] as string);
        expect(EVENT_PERMISSIONS.taskUpdate).toBe(OP_REQUIREMENTS["tasks/list"] as string);
        expect(EVENT_PERMISSIONS.taskLog).toBe(OP_REQUIREMENTS["tasks/getLogs"] as string);
    });

    test("every event kind is classified", () => {
        // The socket authenticates but used to skip permissions entirely, which
        // handed the whole fleet inventory to any account that could log in.
        for (const kind of ["init", "serversUpdate", "statusUpdate", "metrics", "taskUpdate", "taskLog"] as const) {
            expect(EVENT_PERMISSIONS[kind]).toBeTruthy();
        }
    });
});

describe("PANEL_PERMISSIONS is the whole surface", () => {
    test("the id list matches the registry keys", () => {
        expect(PANEL_PERMISSION_IDS.sort()).toEqual(Object.keys(PANEL_PERMISSIONS).sort() as PanelPermission[]);
    });
});
