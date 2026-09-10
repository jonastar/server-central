import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { DEV_SERVER_API_PREFIXES } from "@central/shared";
import { AuthStore } from "../../src/auth";
import { RoleStore } from "../../src/roles";
import { AppStore } from "../../src/features/apps/store";
import { OidcStore } from "../../src/features/oidc/store";
import { RefreshTokenStore } from "../../src/features/oidc/refresh";
import { DeviceCodeStore } from "../../src/features/oidc/device";
import { oidcHttpRoutes } from "../../src/features/oidc/feature";

/**
 * `DEV_SERVER_API_PREFIXES` is the one place the split between "the control
 * plane's paths" and "the SPA's paths" is written down rather than derived, and
 * it is consulted only by `bun run lab web` — the flow where the dev server is
 * the origin the browser opens.
 *
 * That combination is why this test exists. A path missing from the list does
 * not 404 there; it falls through to the SPA shell, so the caller gets `200
 * text/html` and a JSON parse error somewhere far away. `/oidc/revoke` and
 * `/oidc/device_authorization` were both missing for exactly that reason —
 * nothing failed loudly enough to notice.
 */
describe("dev server proxy coverage", () => {
    const covered = (routePath: string) =>
        DEV_SERVER_API_PREFIXES.some((prefix) => routePath === prefix || routePath.startsWith(`${prefix}/`));

    test("every raw HTTP route the OIDC feature registers is proxied", () => {
        // No init(): the route table is built from the closures, and nothing here
        // reads a store — so this costs no keygen and no temp directory.
        const roles = new RoleStore("/nonexistent");
        const routes = oidcHttpRoutes(
            new OidcStore("/nonexistent"),
            new AuthStore(roles, "/nonexistent"),
            new AppStore("/nonexistent"),
            new RefreshTokenStore("/nonexistent"),
            new DeviceCodeStore(),
        );

        const uncovered = routes.map((r) => r.path).filter((p) => !covered(p));
        expect(uncovered).toEqual([]);
        // Guards the guard: if the feature stopped registering routes, the check
        // above would pass vacuously.
        expect(routes.length).toBeGreaterThan(4);
    });

    test("/oidc/authorize is deliberately NOT proxied", () => {
        // It is a browser navigation the SPA renders — the one OIDC path that
        // belongs to the UI. Proxying it would send the user a JSON 404 instead
        // of the consent screen, which is the mirror image of the bug above.
        expect(covered("/oidc/authorize")).toBe(false);
        expect(covered("/device")).toBe(false);
    });

    test("no other feature has quietly grown raw HTTP routes", async () => {
        // The test above can only check the feature it knows to construct. This
        // one fails when a *different* feature starts serving raw paths, which is
        // the moment someone has to decide whether they belong in the list.
        const dir = path.join(import.meta.dir, "../../src/features");
        const owners: string[] = [];
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const file = path.join(dir, entry.name, "feature.ts");
            const source = await readFile(file, "utf8").catch(() => "");
            if (/\bhttpRoutes\s*:/.test(source)) {
                owners.push(entry.name);
            }
        }
        expect(owners.sort()).toEqual(["oidc"]);
    });
});
