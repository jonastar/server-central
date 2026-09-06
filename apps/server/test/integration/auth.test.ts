import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStore } from "../../src/auth";
import { RoleStore } from "../../src/roles";

/** AuthStore resolves role ids to permissions, so tests need a seeded store. */
async function makeRoles(dir: string): Promise<RoleStore> {
    const roles = new RoleStore(dir);
    await roles.init();
    return roles;
}

describe("AuthStore", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-auth-test-"));
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    async function freshStore(): Promise<AuthStore> {
        const store = new AuthStore(await makeRoles(dir), dir);
        await store.init();
        return store;
    }

    test("needsSetup until the owner is created", async () => {
        const store = await freshStore();
        expect(store.needsSetup()).toBe(true);

        const { token, user } = await store.setupOwner("Alice", "supersecret");
        expect(store.needsSetup()).toBe(false);
        expect(user.isOwner).toBe(true);
        expect(user.username).toBe("alice"); // normalized
        expect(token).toBeTruthy();
    });

    test("setupOwner can only run once", async () => {
        const store = await freshStore();
        await store.setupOwner("alice", "supersecret");
        await expect(store.setupOwner("bob", "supersecret")).rejects.toThrow(/already completed/i);
    });

    test("rejects short passwords", async () => {
        const store = await freshStore();
        await expect(store.setupOwner("alice", "short")).rejects.toThrow(/8 characters/);
    });

    test("login succeeds with correct credentials and is case-insensitive on username", async () => {
        const store = await freshStore();
        await store.setupOwner("Alice", "supersecret");

        const { token, user } = await store.login("ALICE", "supersecret");
        expect(user.username).toBe("alice");
        expect(await store.authenticate(token)).toMatchObject({ username: "alice" });
    });

    test("login fails for wrong password and unknown user with the same error", async () => {
        const store = await freshStore();
        await store.setupOwner("alice", "supersecret");

        await expect(store.login("alice", "wrongpass")).rejects.toThrow(/invalid username or password/i);
        await expect(store.login("nobody", "whatever1")).rejects.toThrow(/invalid username or password/i);
    });

    test("authenticate rejects unknown / logged-out tokens", async () => {
        const store = await freshStore();
        const { token } = await store.setupOwner("alice", "supersecret");

        expect(await store.authenticate(null)).toBeNull();
        expect(await store.authenticate("garbage")).toBeNull();
        expect(await store.authenticate(token)).not.toBeNull();

        await store.logout(token);
        expect(await store.authenticate(token)).toBeNull();
    });

    test("users and sessions persist across restarts", async () => {
        const first = await freshStore();
        const { token } = await first.setupOwner("alice", "supersecret");

        const second = await freshStore(); // re-reads the same dir
        expect(second.needsSetup()).toBe(false);
        expect(await second.authenticate(token)).toMatchObject({ username: "alice" });
    });

    describe("email", () => {
        test("is optional, and normalized on the way in", async () => {
            const store = await freshStore();
            const { user } = await store.setupOwner("alice", "supersecret");
            expect(user.email).toBeNull();

            await store.setEmail(user.id, "  Alice@Example.COM  ");
            expect(store.getUserById(user.id)?.email).toBe("alice@example.com");
        });

        test("clears on null, and on a value that is only whitespace", async () => {
            const store = await freshStore();
            const { user } = await store.setupOwner("alice", "supersecret");
            await store.setEmail(user.id, "alice@example.com");

            await store.setEmail(user.id, null);
            expect(store.getUserById(user.id)?.email).toBeNull();

            // An empty string must not persist as one: two accounts holding ""
            // would compare equal and trip the uniqueness check against
            // each other.
            await store.setEmail(user.id, "   ");
            expect(store.getUserById(user.id)?.email).toBeNull();
        });

        test("is unique across accounts", async () => {
            const store = await freshStore();
            const { user: owner } = await store.setupOwner("alice", "supersecret");
            const bob = await store.addUser("bob", "supersecret", []);
            await store.setEmail(owner.id, "shared@example.com");

            // Relying parties key accounts on the address (Immich does), so two
            // accounts sharing one collapse into a single account over there.
            await expect(store.setEmail(bob.id, "shared@example.com")).rejects.toThrow(/already uses/i);
            await expect(store.setEmail(bob.id, "SHARED@example.com")).rejects.toThrow(/already uses/i);
            expect(store.getUserById(bob.id)?.email).toBeNull();

            // Re-setting your own address is not a collision with yourself.
            await store.setEmail(owner.id, "shared@example.com");
            expect(store.getUserById(owner.id)?.email).toBe("shared@example.com");
        });

        test("rejects addresses that would break a relying party", async () => {
            const store = await freshStore();
            const { user } = await store.setupOwner("alice", "supersecret");
            for (const bad of ["alice", "alice@", "@example.com", "alice@example", "a b@example.com"]) {
                await expect(store.setEmail(user.id, bad)).rejects.toThrow(/invalid email/i);
            }
            expect(store.getUserById(user.id)?.email).toBeNull();
        });

        test("can be set at creation, and survives a restart", async () => {
            const first = await freshStore();
            await first.setupOwner("alice", "supersecret");
            const bob = await first.addUser("bob", "supersecret", [], "Bob@Example.com");
            expect(bob.email).toBe("bob@example.com");

            await expect(first.addUser("carol", "supersecret", [], "bob@example.com")).rejects.toThrow(/already uses/i);

            const second = await freshStore();
            expect(second.getUserById(bob.id)?.email).toBe("bob@example.com");
        });
    });
});
