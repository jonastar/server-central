import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AppStore } from "../../src/features/apps/store";
import { OidcStore } from "../../src/features/oidc/store";
import { effectiveGroupPrefix } from "../../src/features/oidc/feature";

describe("AppStore", () => {
    let dir: string;
    let apps: AppStore;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-apps-test-"));
        apps = new AppStore(dir);
        await apps.init();
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    test("creates, normalizes and persists", async () => {
        const app = await apps.create("Immich", "  IMMICH  ", ["Admin", "user", "admin"]);
        expect(app.slug).toBe("immich");
        // Roles are the leaf of app.<slug>.<role>, so they normalize the same
        // way, and a repeat is dropped rather than rejected.
        expect(app.roles).toEqual(["admin", "user"]);

        const reopened = new AppStore(dir);
        await reopened.init();
        expect(reopened.get(app.id)?.slug).toBe("immich");
        expect(reopened.slugFor(app.id)).toBe("immich");
        expect(reopened.slugFor("no-such-app")).toBeNull();
        expect(reopened.slugFor(null)).toBeNull();
    });

    test("rejects slugs and roles that would name nothing", async () => {
        // `app.<slug>.*` is a dotted namespace: a slug containing a dot or a
        // space produces nodes that silently match no grant at all.
        for (const bad of ["im.mich", "im mich", "-immich", "", "  "]) {
            await expect(apps.create("Immich", bad)).rejects.toThrow(/invalid app id/i);
        }
        await expect(apps.create("Immich", "immich", ["read write"])).rejects.toThrow(/invalid role name/i);
        await expect(apps.create("   ", "immich")).rejects.toThrow(/name is required/i);
    });

    test("slugs are unique, since they are the identity other records point at", async () => {
        await apps.create("Immich", "immich");
        await expect(apps.create("Immich Two", "immich")).rejects.toThrow(/already uses/i);

        const other = await apps.create("Jellyfin", "jellyfin");
        await expect(apps.update({ ...other, slug: "immich" })).rejects.toThrow(/already uses/i);
        // Keeping your own slug is not a collision with yourself.
        await apps.update({ ...other, name: "Jellyfin Media" });
        expect(apps.get(other.id)?.name).toBe("Jellyfin Media");
    });

    test("update cannot rewrite createdAt", async () => {
        const app = await apps.create("Immich", "immich");
        await apps.update({ ...app, createdAt: 0 });
        expect(apps.get(app.id)?.createdAt).toBe(app.createdAt);
    });

    test("refuses to delete an app an SSO client still points at", async () => {
        const app = await apps.create("Immich", "immich");
        // Deleting would leave a dangling appId, which resolves to "no prefix" —
        // and no prefix means the client is told *every* app role the user
        // holds. A silent delete would widen the claim, not narrow it.
        await expect(apps.delete(app.id, 1)).rejects.toThrow(/still reference/i);
        expect(apps.get(app.id)).not.toBeNull();

        await apps.delete(app.id, 0);
        expect(apps.get(app.id)).toBeNull();
    });
});

describe("effectiveGroupPrefix", () => {
    let dir: string;
    let apps: AppStore;
    let oidc: OidcStore;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-prefix-test-"));
        apps = new AppStore(dir);
        await apps.init();
        oidc = new OidcStore(dir);
        await oidc.init();
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    test("resolves through the linked app, falls back, and defaults to unscoped", async () => {
        const app = await apps.create("Immich", "immich");
        const linked = (await oidc.createClient("Immich", ["https://p.example.com/cb"], app.id)).client;
        expect(effectiveGroupPrefix(linked, apps)).toBe("immich");

        const unlinked = (await oidc.createClient("Jellyfin", ["https://tv.example.com/cb"])).client;
        expect(effectiveGroupPrefix(unlinked, apps)).toBeNull();

        // Registrations made before Apps existed set the prefix directly; they
        // keep working rather than silently losing their scoping on upgrade.
        expect(effectiveGroupPrefix({ ...unlinked, groupPrefix: "legacy" }, apps)).toBe("legacy");
        // A link wins over the legacy field — the App's slug is the definition.
        expect(effectiveGroupPrefix({ ...linked, groupPrefix: "stale" }, apps)).toBe("immich");
    });

    test("renaming an app's slug re-scopes its clients with no client-side change", async () => {
        const app = await apps.create("Immich", "immich");
        const client = (await oidc.createClient("Immich", ["https://p.example.com/cb"], app.id)).client;
        await apps.update({ ...app, slug: "photos" });
        // The whole point of the reference: one edit moves the namespace, rather
        // than needing the same string retyped everywhere it was copied to.
        expect(effectiveGroupPrefix(client, apps)).toBe("photos");
    });
});
