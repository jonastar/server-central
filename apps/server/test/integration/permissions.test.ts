import { describe, expect, test } from "bun:test";
import {
    PANEL_PERMISSION_IDS,
    SEED_ROLES,
    SENSITIVE_PERMISSIONS,
    effectivePermissions,
    hasAnyPermission,
    hasPermission,
    isValidPermission,
    permissionMatches,
    permissionOverlaps,
    userCan,
    type Permission,
    type RoleDef,
} from "@central/shared";

describe("permissionMatches", () => {
    test("exact match", () => {
        expect(permissionMatches("panel.files.read", "panel.files.read")).toBe(true);
        expect(permissionMatches("panel.files.read", "panel.files.write")).toBe(false);
    });

    test("`*` matches everything", () => {
        expect(permissionMatches("*", "panel.files.read")).toBe(true);
        expect(permissionMatches("*", "app.immich.admin")).toBe(true);
    });

    test("a prefix wildcard covers its subtree", () => {
        expect(permissionMatches("panel.*", "panel.files.read")).toBe(true);
        expect(permissionMatches("panel.files.*", "panel.files.write")).toBe(true);
        expect(permissionMatches("app.immich.*", "app.immich.admin")).toBe(true);
    });

    test("a prefix wildcard does not escape its subtree", () => {
        expect(permissionMatches("panel.files.*", "panel.docker.read")).toBe(false);
        expect(permissionMatches("app.*", "panel.files.read")).toBe(false);
    });

    test("a bare node is not an implicit wildcard", () => {
        // Holding the parent must not grant the children — only an explicit
        // `.*` does, which is what keeps "what does this grant" readable.
        expect(permissionMatches("panel.files", "panel.files.read")).toBe(false);
        expect(permissionMatches("panel", "panel.files.read")).toBe(false);
    });

    test("a wildcard does not match a sibling sharing a name prefix", () => {
        // "panel.file.*" must not reach "panel.files.read": the segment boundary
        // matters, and this is exactly what a naive startsWith() gets wrong.
        expect(permissionMatches("panel.file.*", "panel.files.read")).toBe(false);
    });

    test("suffix globs are not a thing", () => {
        expect(permissionMatches("*.admin", "app.immich.admin")).toBe(false);
        expect(permissionMatches("app.*.admin", "app.immich.admin")).toBe(false);
    });
});

describe("hasPermission", () => {
    test("any one held node is enough", () => {
        expect(hasPermission(["panel.docker.read", "panel.files.read"], "panel.files.read")).toBe(true);
        expect(hasPermission(["panel.docker.read"], "panel.files.read")).toBe(false);
    });

    test("an empty set grants nothing", () => {
        expect(hasPermission([], "panel.files.read")).toBe(false);
    });

    test("sensitive nodes ignore wildcards entirely", () => {
        for (const node of SENSITIVE_PERMISSIONS) {
            expect(hasPermission(["*"], node)).toBe(false);
            expect(hasPermission(["panel.*"], node)).toBe(false);
            expect(hasPermission([node], node)).toBe(true);
        }
    });

    test("a wildcard still covers non-sensitive nodes alongside them", () => {
        expect(hasPermission(["panel.*"], "panel.files.write")).toBe(true);
    });

    test("hasAnyPermission: empty requirement means no specific node is needed", () => {
        expect(hasAnyPermission([], [])).toBe(true);
        expect(hasAnyPermission([], ["app.immich.user"])).toBe(false);
        expect(hasAnyPermission(["app.immich.admin"], ["app.immich.*", "app.jellyfin.*"])).toBe(true);
    });
});

describe("seed roles", () => {
    test("every seeded node is one the registry declares", () => {
        for (const role of SEED_ROLES) {
            for (const node of role.permissions) {
                expect(PANEL_PERMISSION_IDS).toContain(node as never);
            }
        }
    });

    test("the seeds nest: viewer ⊂ operator ⊂ admin", () => {
        for (let i = 1; i < SEED_ROLES.length; i++) {
            for (const node of SEED_ROLES[i - 1].permissions) {
                expect(SEED_ROLES[i].permissions, `${SEED_ROLES[i].id} should include ${node}`).toContain(node);
            }
        }
    });

    test("viewer holds only read nodes", () => {
        for (const node of SEED_ROLES[0].permissions) {
            expect(node.endsWith(".read")).toBe(true);
        }
    });

    test("account and role management stay with the owner", () => {
        for (const role of SEED_ROLES) {
            expect(role.permissions).not.toContain("panel.users.admin");
            expect(role.permissions).not.toContain("panel.roles.admin");
        }
    });

    test("they're named for the half of the namespace they grant", () => {
        for (const role of SEED_ROLES) {
            expect(role.name.startsWith("Control panel ")).toBe(true);
            expect(role.permissions.every((p) => p.startsWith("panel."))).toBe(true);
        }
    });
});

describe("effectivePermissions", () => {
    const viewer = SEED_ROLES[0];
    const operator = SEED_ROLES[1];

    test("unions several roles and ad-hoc grants", () => {
        const set = effectivePermissions(false, [viewer, operator], ["app.immich.user"]);
        expect(set).toContain("panel.files.read");
        expect(set).toContain("panel.files.write");
        expect(set).toContain("app.immich.user");
    });

    test("deduplicates across overlapping roles", () => {
        const set = effectivePermissions(false, [viewer, operator]);
        expect(set.filter((p) => p === "panel.files.read")).toHaveLength(1);
    });

    test("no roles at all is the floor", () => {
        expect(effectivePermissions(false, [])).toEqual([]);
    });

    test("an app-only account: no roles, one app grant", () => {
        const user = { isOwner: false, permissions: effectivePermissions(false, [], ["app.immich.user"]) };
        expect(userCan(user, "app.immich.user")).toBe(true);
        expect(userCan(user, "panel.files.read")).toBe(false);
        expect(userCan(user, "panel.terminal")).toBe(false);
    });

    test("the owner reports `*` but is checked by the flag, not by that set", () => {
        expect(effectivePermissions(true, [])).toEqual(["*"]);
        const owner = { isOwner: true, permissions: effectivePermissions(true, []) };
        for (const node of SENSITIVE_PERMISSIONS) {
            expect(userCan(owner, node)).toBe(true);
            // `*` alone would not have reached these — the bypass is what does.
            expect(hasPermission(owner.permissions, node)).toBe(false);
        }
    });

    test("a role whose id no longer exists simply grants nothing", () => {
        const dangling: RoleDef[] = [];
        expect(effectivePermissions(false, dangling)).toEqual([]);
    });
});

describe("userCan", () => {
    test("no user is never permitted", () => {
        expect(userCan(null, "panel.files.read")).toBe(false);
        expect(userCan(undefined, "panel.files.read")).toBe(false);
    });

    test("a granted wildcard cannot be used to reach a terminal", () => {
        const user = { isOwner: false, permissions: effectivePermissions(false, [SEED_ROLES[1]], ["panel.*"]) };
        expect(userCan(user, "panel.settings.admin")).toBe(true);
        expect(userCan(user, "panel.terminal")).toBe(false);
        expect(userCan(user, "panel.docker.exec")).toBe(false);
    });
});

describe("isValidPermission", () => {
    test("accepts nodes and prefix wildcards", () => {
        for (const ok of ["*", "panel.terminal", "panel.files.read", "app.immich.*", "app.immich.user"]) {
            expect(isValidPermission(ok)).toBe(true);
        }
    });

    test("rejects shapes the matcher can't reason about", () => {
        for (const bad of ["", ".", "panel.", "panel..read", "*.admin", "app.*.admin", "panel files", "-panel.terminal"]) {
            expect(isValidPermission(bad as Permission)).toBe(false);
        }
    });
});
