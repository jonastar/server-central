import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PANEL_PERMISSION_IDS, SEED_ROLES, TASK_KIND_PERMISSIONS, canRunTask, effectivePermissions, escalationsIn, permissionDef, roleMatchesSeed, seedRoleFor, userCan } from "@central/shared";
import { AuthStore } from "../../src/auth";
import { RoleStore } from "../../src/roles";

describe("RoleStore", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-roles-test-"));
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    async function fresh(): Promise<RoleStore> {
        const store = new RoleStore(dir);
        await store.init();
        return store;
    }

    test("seeds the shipped roles on first run and persists them", async () => {
        const store = await fresh();
        expect(store.list().map((r) => r.id).sort()).toEqual(SEED_ROLES.map((r) => r.id).sort());

        const reloaded = await fresh();
        expect(reloaded.list()).toHaveLength(SEED_ROLES.length);
    });

    test("an edited seed role survives a restart unchanged", async () => {
        // The whole reason roles are seeded rather than code-defined: what the
        // installation decides "operator" means is the installation's, and a
        // later release must not quietly widen it.
        const store = await fresh();
        const operator = store.list().find((r) => r.id === "operator")!;
        await store.update({ ...operator, permissions: ["panel.files.read"] });

        const reloaded = await fresh();
        expect(reloaded.get("operator")!.permissions).toEqual(["panel.files.read"]);
    });

    test("does not re-seed over an installation that deleted a role", async () => {
        const store = await fresh();
        await store.delete("viewer", 0);
        expect((await fresh()).get("viewer")).toBeNull();
    });

    test("rejects unknown panel nodes but allows any app node", async () => {
        const store = await fresh();
        // A role is assembled from a list, so an unrecognised panel node is a
        // typo — unlike `app.*`, whose names aren't ours to know.
        await expect(store.create("Bad", "", ["panel.zfz.read"])).rejects.toThrow(/unknown permission/i);
        await expect(store.create("Bad", "", ["not a node"])).rejects.toThrow(/invalid permission/i);
        const ok = await store.create("Photos", "Immich only", ["app.immich.user", "app.whatever.thing"]);
        expect(ok.permissions).toEqual(["app.immich.user", "app.whatever.thing"]);
    });

    test("deduplicates and requires a name", async () => {
        const store = await fresh();
        await expect(store.create("  ", "", [])).rejects.toThrow(/name is required/i);
        const role = await store.create("Dupes", "", ["panel.files.read", "panel.files.read"]);
        expect(role.permissions).toEqual(["panel.files.read"]);
    });

    test("refuses to delete a role someone still holds", async () => {
        const store = await fresh();
        await expect(store.delete("viewer", 2)).rejects.toThrow(/2 accounts still hold this role/);
        expect(store.get("viewer")).not.toBeNull();
    });

    test("resolve skips ids that no longer exist rather than throwing", async () => {
        // A dangling id must degrade to "grants nothing" — throwing here would
        // fail every request the holder makes, including the ones that would let
        // an admin fix it.
        const store = await fresh();
        expect(store.resolve(["viewer", "ghost"]).map((r) => r.id)).toEqual(["viewer"]);
    });
});

describe("AuthStore with roles", () => {
    let dir: string;
    let roles: RoleStore;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-authroles-test-"));
        roles = new RoleStore(dir);
        await roles.init();
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    async function store(): Promise<AuthStore> {
        const s = new AuthStore(roles, dir);
        await s.init();
        return s;
    }

    test("the owner holds no roles and bypasses everything", async () => {
        const auth = await store();
        const { user } = await auth.setupOwner("alice", "supersecret");
        expect(user.isOwner).toBe(true);
        expect(user.roleIds).toEqual([]);
        expect(userCan(user, "panel.terminal")).toBe(true);
    });

    test("a user with several roles gets the union", async () => {
        const auth = await store();
        await auth.setupOwner("alice", "supersecret");
        const bob = await auth.addUser("bob", "supersecret", ["viewer", "operator"]);
        expect(userCan(bob, "panel.files.read")).toBe(true);
        expect(userCan(bob, "panel.files.write")).toBe(true);
        expect(userCan(bob, "panel.terminal")).toBe(false);
    });

    test("a user with no roles reaches nothing", async () => {
        const auth = await store();
        await auth.setupOwner("alice", "supersecret");
        const gran = await auth.addUser("gran", "supersecret", []);
        expect(gran.permissions).toEqual([]);
        expect(userCan(gran, "panel.servers.read")).toBe(false);
    });

    test("unknown role ids are refused rather than stored dangling", async () => {
        const auth = await store();
        await auth.setupOwner("alice", "supersecret");
        await expect(auth.addUser("bob", "supersecret", ["ghost"])).rejects.toThrow(/unknown role/i);
    });

    test("editing a role changes what its holders can do, with no migration", async () => {
        const auth = await store();
        await auth.setupOwner("alice", "supersecret");
        const bob = await auth.addUser("bob", "supersecret", ["viewer"]);
        expect(userCan(bob, "panel.files.write")).toBe(false);

        const viewer = roles.get("viewer")!;
        await roles.update({ ...viewer, permissions: [...viewer.permissions, "panel.files.write"] });
        // Effective permissions are merged on read, so the change is immediate.
        expect(userCan(auth.listUsers().find((u) => u.username === "bob")!, "panel.files.write")).toBe(true);
    });

    test("countRoleHolders is what the delete guard counts", async () => {
        const auth = await store();
        await auth.setupOwner("alice", "supersecret");
        await auth.addUser("bob", "supersecret", ["viewer"]);
        await auth.addUser("carol", "supersecret", ["viewer", "operator"]);
        expect(auth.countRoleHolders("viewer")).toBe(2);
        expect(auth.countRoleHolders("operator")).toBe(1);
        expect(auth.countRoleHolders("admin")).toBe(0);
    });

    test("the owner can't be assigned roles", async () => {
        const auth = await store();
        const { user } = await auth.setupOwner("alice", "supersecret");
        await expect(auth.setUserRoles(user.id, ["viewer"])).rejects.toThrow(/owner/i);
    });

    test("app grants merge on top for owners too, so SSO claims work", async () => {
        // Owning the control plane deliberately doesn't make you an admin in
        // every connected app, so an owner grants themselves app roles like
        // anyone else — which means extras must not be dropped for owners.
        const auth = await store();
        const { user } = await auth.setupOwner("alice", "supersecret");
        await auth.setPermissions(user.id, ["app.immich.admin"]);
        const reloaded = auth.listUsers()[0];
        expect(reloaded.permissions).toContain("app.immich.admin");
        expect(reloaded.permissions.filter((p) => p.startsWith("app."))).toEqual(["app.immich.admin"]);
    });
});

describe("migration from single-role records", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-rolemig-test-"));
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    test("old `role` values become isOwner / roleIds", async () => {
        const legacy = {
            u1: { id: "u1", username: "alice", passwordHash: "x", role: "owner", createdAt: 1 },
            u2: { id: "u2", username: "bob", passwordHash: "x", role: "operator", createdAt: 2 },
            u3: { id: "u3", username: "gran", passwordHash: "x", role: "none", createdAt: 3 },
        };
        await fs.writeFile(path.join(dir, "users.json"), JSON.stringify(legacy));

        const roles = new RoleStore(dir);
        await roles.init();
        const auth = new AuthStore(roles, dir);
        await auth.init();

        const byName = Object.fromEntries(auth.listUsers().map((u) => [u.username, u]));
        expect(byName.alice.isOwner).toBe(true);
        expect(byName.alice.roleIds).toEqual([]);
        // The seeded ids match the old role names, which is what makes this a
        // rename rather than a mapping table.
        expect(byName.bob.roleIds).toEqual(["operator"]);
        expect(userCan(byName.bob, "panel.files.write")).toBe(true);
        expect(byName.gran.roleIds).toEqual([]);
        expect(byName.gran.permissions).toEqual([]);

        // Persisted, so it happens once rather than on every boot.
        const raw = JSON.parse(await fs.readFile(path.join(dir, "users.json"), "utf8"));
        expect(raw.u2.role).toBeUndefined();
        expect(raw.u2.roleIds).toEqual(["operator"]);
    });
});

describe("effectivePermissions", () => {
    test("no roles is the floor; roles union; extras add", () => {
        expect(effectivePermissions(false, [])).toEqual([]);
        const merged = effectivePermissions(false, [...SEED_ROLES], ["app.immich.user"]);
        expect(merged).toContain("panel.terminal");
        expect(merged).toContain("app.immich.user");
    });
});

describe("escalation marks", () => {
    test("every marked node explains how, in a sentence", () => {
        // The mark is the explanation — a bare boolean would tell someone a
        // permission is dangerous without telling them why, which is the part
        // that changes a decision.
        for (const id of PANEL_PERMISSION_IDS) {
            const why = permissionDef(id).escalation;
            if (why !== undefined) {
                expect(why.length, `"${id}" has an empty escalation note`).toBeGreaterThan(30);
                expect(why.trim().endsWith("."), `"${id}" escalation should be a sentence`).toBe(true);
            }
        }
    });

    test("the write surfaces that are root-by-side-channel are all marked", () => {
        // The agent runs as root, so these are root-equivalent whether or not
        // their names suggest it. Each one has a concrete published route:
        // sudoers.d, a compose bind mount of /, the control-plane binary.
        for (const id of ["panel.files.write", "panel.files.read", "panel.compose.write", "panel.docker.deploy", "panel.docker.exec", "panel.settings.admin", "panel.proxy.admin", "panel.servers.admin", "panel.systemUsers.admin", "panel.exec", "panel.terminal"] as const) {
            expect(permissionDef(id).escalation, `"${id}" should carry an escalation note`).toBeTruthy();
        }
    });

    test("controlling existing containers is not marked; deploying is", () => {
        // The split exists precisely so restarting something someone else
        // defined isn't lumped in with instantiating a definition of your own.
        expect(permissionDef("panel.docker.control").escalation).toBeUndefined();
        expect(permissionDef("panel.docker.prune").escalation).toBeUndefined();
        expect(permissionDef("panel.docker.deploy").escalation).toBeTruthy();
    });

    test("read-only nodes are otherwise unmarked", () => {
        for (const id of ["panel.docker.read", "panel.servers.read", "panel.systemd.read", "panel.zfs.read", "panel.tasks.read"] as const) {
            expect(permissionDef(id).escalation).toBeUndefined();
        }
    });

    test("escalationsIn summarises a whole bundle", () => {
        const operator = SEED_ROLES.find((r) => r.id === "operator")!;
        expect(escalationsIn(operator.permissions).length).toBeGreaterThan(1);
        expect(escalationsIn([]).length).toBe(0);
    });

    test("the seeded viewer grants no path to root at all", () => {
        // The property that makes "read-only" a tier worth having, and the one
        // most easily lost: it holds if and only if nothing in the bundle is
        // marked. Adding a marked node to this role should fail here.
        const viewer = SEED_ROLES.find((r) => r.id === "viewer")!;
        expect(escalationsIn(viewer.permissions)).toEqual([]);
    });

    test("mounts and devices are readable without file contents", () => {
        // The split that makes the viewer's loss of files.read survivable: host
        // inventory is not the same disclosure as arbitrary file contents.
        const viewer = SEED_ROLES.find((r) => r.id === "viewer")!;
        expect(viewer.permissions).toContain("panel.mounts.read");
        expect(viewer.permissions).not.toContain("panel.files.read");
        expect(permissionDef("panel.mounts.read").escalation).toBeUndefined();
    });
});

describe("docker permission split", () => {
    test("lifecycle and deployment are separate task gates", () => {
        expect(TASK_KIND_PERMISSIONS.docker_container_action).toBe("panel.docker.control");
        expect(TASK_KIND_PERMISSIONS.docker_stack_action).toBe("panel.docker.control");
        expect(TASK_KIND_PERMISSIONS.docker_compose_action).toBe("panel.docker.deploy");
        expect(TASK_KIND_PERMISSIONS.docker_image_pull).toBe("panel.docker.deploy");
    });

    test("a control-only role can restart but not deploy", () => {
        const user = { isOwner: false, permissions: ["panel.tasks.run", "panel.docker.control"] };
        expect(canRunTask(user, "docker_container_action")).toBe(true);
        expect(canRunTask(user, "docker_compose_action")).toBe(false);
        expect(userCan(user, "panel.docker.prune")).toBe(false);
    });
});

describe("resetting a seeded role", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-rolereset-test-"));
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    async function fresh(): Promise<RoleStore> {
        const store = new RoleStore(dir);
        await store.init();
        return store;
    }

    test("restores permissions, name and description", async () => {
        const store = await fresh();
        const seed = SEED_ROLES.find((r) => r.id === "operator")!;
        await store.update({ id: "operator", name: "Mangled", description: "oops", permissions: ["panel.files.read"] });
        expect(roleMatchesSeed(store.get("operator")!)).toBe(false);

        const reset = await store.resetToSeed("operator");
        expect(reset.name).toBe(seed.name);
        expect(reset.permissions.sort()).toEqual([...seed.permissions].sort());
        expect(roleMatchesSeed(store.get("operator")!)).toBe(true);
    });

    test("recreates a seeded role that was deleted", async () => {
        // The case a client-side "write the seed back" reset couldn't handle:
        // there's no role left to update.
        const store = await fresh();
        await store.delete("viewer", 0);
        expect(store.get("viewer")).toBeNull();

        await store.resetToSeed("viewer");
        expect(roleMatchesSeed(store.get("viewer")!)).toBe(true);
    });

    test("refuses a custom role, which has no default", async () => {
        const store = await fresh();
        const custom = await store.create("Photos", "Immich only", ["app.immich.user"]);
        await expect(store.resetToSeed(custom.id)).rejects.toThrow(/no default|only the roles/i);
    });

    test("persists, so it isn't undone by a restart", async () => {
        const store = await fresh();
        await store.update({ id: "viewer", name: "x", description: "y", permissions: [] });
        await store.resetToSeed("viewer");
        expect(roleMatchesSeed((await fresh()).get("viewer")!)).toBe(true);
    });

    test("is how a role picks up a permission added in a later release", async () => {
        // Updates never widen a role, so a node added to the shipped seed lands
        // nowhere until someone resets — which is the other half of that bargain.
        const store = await fresh();
        const viewer = store.get("viewer")!;
        await store.update({ ...viewer, permissions: viewer.permissions.filter((p) => p !== "panel.zfs.read") });
        expect(store.get("viewer")!.permissions).not.toContain("panel.zfs.read");

        await store.resetToSeed("viewer");
        expect(store.get("viewer")!.permissions).toContain("panel.zfs.read");
    });

    test("roleMatchesSeed ignores permission order but not membership", async () => {
        const store = await fresh();
        const viewer = store.get("viewer")!;
        await store.update({ ...viewer, permissions: [...viewer.permissions].reverse() });
        expect(roleMatchesSeed(store.get("viewer")!)).toBe(true);

        await store.update({ ...viewer, permissions: [...viewer.permissions, "panel.files.read"] });
        expect(roleMatchesSeed(store.get("viewer")!)).toBe(false);
    });

    test("a custom role never matches a seed", async () => {
        const store = await fresh();
        const custom = await store.create("Mimic", "", []);
        expect(roleMatchesSeed(custom)).toBe(false);
        expect(seedRoleFor(custom.id)).toBeNull();
    });
});
