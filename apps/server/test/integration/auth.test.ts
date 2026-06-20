import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStore } from "../../src/auth";

describe("AuthStore", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-auth-test-"));
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    async function freshStore(): Promise<AuthStore> {
        const store = new AuthStore(dir);
        await store.init();
        return store;
    }

    test("needsSetup until the owner is created", async () => {
        const store = await freshStore();
        expect(store.needsSetup()).toBe(true);

        const { token, user } = await store.setupOwner("Alice", "supersecret");
        expect(store.needsSetup()).toBe(false);
        expect(user.role).toBe("owner");
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
});
