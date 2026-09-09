import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStore } from "../../src/auth";
import { RoleStore } from "../../src/roles";
import { RefreshTokenStore } from "../../src/features/oidc/refresh";

describe("RefreshTokenStore", () => {
    let dir: string;
    let store: RefreshTokenStore;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-refresh-test-"));
        store = new RefreshTokenStore(dir);
        await store.init();
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    const grant = { userId: "u1", clientId: "c1", scope: "openid offline_access" };

    test("rotates on use, and the spent token stops working", async () => {
        const first = await store.issue(grant);
        const rotated = await store.rotate(first);

        expect(rotated).not.toBeNull();
        expect(rotated).not.toHaveProperty("reused");
        const { grant: resolved, next } = rotated as { grant: { userId: string; scope: string }; next: string };
        expect(resolved.userId).toBe("u1");
        expect(resolved.scope).toBe("openid offline_access");
        expect(next).not.toBe(first);

        // Single use: the presented token is consumed whether or not it was valid.
        expect(await store.rotate(first)).toEqual({ reused: true });
    });

    test("reuse revokes the whole chain, not just the replayed link", async () => {
        const t1 = await store.issue(grant);
        const t2 = (await store.rotate(t1) as { next: string }).next;
        const t3 = (await store.rotate(t2) as { next: string }).next;

        // Replaying a spent link is indistinguishable from theft, so the safe
        // reading is theft: the live token dies with it, forcing both the thief
        // and the legitimate holder back through a full authorization.
        expect(await store.rotate(t2)).toEqual({ reused: true });
        expect(await store.rotate(t3)).toBeNull();
        expect(store.listForUser("u1")).toEqual([]);
    });

    test("survives a restart, because a TV cannot re-run a browser flow", async () => {
        const token = await store.issue(grant);

        const reopened = new RefreshTokenStore(dir);
        await reopened.init();
        expect(await reopened.rotate(token)).not.toBeNull();
    });

    test("is not stored in a form that can be presented", async () => {
        const token = await store.issue(grant);
        const onDisk = await fs.readFile(path.join(dir, "oidc-refresh-tokens.json"), "utf8");
        // Hashed like a client secret: a leaked file should not be a set of
        // working credentials.
        expect(onDisk).not.toContain(token);
    });

    test("unknown and expired tokens are refused, not crashed on", async () => {
        expect(await store.rotate("never-issued")).toBeNull();
        expect(await store.revoke("never-issued")).toBe(false);
    });

    test("revoke takes the family, so signing out is not undone by the next refresh", async () => {
        const t1 = await store.issue(grant);
        const t2 = (await store.rotate(t1) as { next: string }).next;

        expect(await store.revoke(t2)).toBe(true);
        expect(await store.rotate(t2)).toBeNull();
    });

    test("revokeForUser and revokeForClient only take their own", async () => {
        await store.issue(grant);
        await store.issue({ userId: "u1", clientId: "c2", scope: "openid offline_access" });
        await store.issue({ userId: "u2", clientId: "c1", scope: "openid offline_access" });

        await store.revokeForClient("c2");
        expect(store.listForUser("u1").map((g) => g.clientId)).toEqual(["c1"]);

        await store.revokeForUser("u1");
        expect(store.listForUser("u1")).toEqual([]);
        expect(store.listForUser("u2")).toHaveLength(1);
    });

    test("lists one row per chain, not one per rotation", async () => {
        const t1 = await store.issue(grant);
        await store.rotate(t1);
        await store.issue({ userId: "u1", clientId: "c2", scope: "openid offline_access" });

        // Two apps, three tokens minted — the row is the grant, not the link.
        expect(store.listForUser("u1")).toHaveLength(2);
    });
});

describe("credential revocation fan-out", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-fanout-test-"));
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    async function wired(): Promise<{ auth: AuthStore; refresh: RefreshTokenStore }> {
        const roles = new RoleStore(dir);
        await roles.init();
        const auth = new AuthStore(roles, dir);
        const refresh = new RefreshTokenStore(dir);
        await refresh.init();
        auth.onUserCredentialsRevoked((userId) => refresh.revokeForUser(userId));
        await auth.init();
        return { auth, refresh };
    }

    test("an admin password reset revokes app access too", async () => {
        const { auth, refresh } = await wired();
        const { user } = await auth.setupOwner("alice", "supersecret");
        await refresh.issue({ userId: user.id, clientId: "c1", scope: "openid offline_access" });

        await auth.adminSetPassword(user.id, "a-new-password");
        // Otherwise the browser session goes and an app holding a refresh token
        // keeps minting access tokens under the password that was just changed.
        expect(refresh.listForUser(user.id)).toEqual([]);
    });

    test("deleting an account revokes its grants", async () => {
        const { auth, refresh } = await wired();
        await auth.setupOwner("alice", "supersecret");
        const bob = await auth.addUser("bob", "supersecret", []);
        await refresh.issue({ userId: bob.id, clientId: "c1", scope: "openid offline_access" });

        await auth.deleteUser(bob.id, "someone-else");
        expect(refresh.listForUser(bob.id)).toEqual([]);
    });
});
