import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { App } from "@central/shared";
import { CONFIG_DIR, writeFileAtomic } from "../../config";

/**
 * File-backed App registry (`.sc-data/apps-registry.json`), same atomic-write
 * shape as the other stores.
 *
 * Not `apps.json` — that name is already taken by the OIDC client registrations,
 * for historical reasons the shared domain comment explains. Renaming that file
 * would be the tidier end state, but it would also invalidate every registered
 * relying party's config on upgrade, which is a bad trade for a filename.
 */
export class AppStore {
    private apps: Record<string, App> = {};
    private readonly file: string;

    constructor(dataDir: string = CONFIG_DIR) {
        this.file = path.join(dataDir, "apps-registry.json");
    }

    async init(): Promise<void> {
        try {
            this.apps = JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, App>;
        } catch {
            this.apps = {};
        }
    }

    list(): App[] {
        return Object.values(this.apps).sort((a, b) => a.name.localeCompare(b.name));
    }

    get(appId: string): App | null {
        return this.apps[appId] ?? null;
    }

    /** The `app.<slug>.` namespace an App owns, or null for an unknown id. Used
     *  to scope the OIDC `groups` claim without the caller needing the record. */
    slugFor(appId: string | null): string | null {
        return appId ? this.apps[appId]?.slug ?? null : null;
    }

    async create(name: string, slug: string, roles: string[] = []): Promise<App> {
        const app: App = {
            id: randomUUID(),
            name: assertName(name),
            slug: assertSlug(slug),
            roles: assertRoles(roles),
            createdAt: Date.now(),
        };
        this.assertSlugFree(app.slug, null);
        this.apps[app.id] = app;
        await this.persist();
        return app;
    }

    async update(next: App): Promise<void> {
        const existing = this.apps[next.id];
        if (!existing) {
            throw new Error("App not found");
        }
        const slug = assertSlug(next.slug);
        this.assertSlugFree(slug, next.id);
        // createdAt is the record's own, never the caller's.
        this.apps[next.id] = { ...existing, name: assertName(next.name), slug, roles: assertRoles(next.roles) };
        await this.persist();
    }

    /** `referenceCount` is supplied by the caller (the feature layer knows which
     *  stores point here), mirroring how `RoleStore.delete` is told its holder
     *  count rather than reaching across features to count them itself. */
    async delete(appId: string, referenceCount: number): Promise<void> {
        if (!this.apps[appId]) {
            return;
        }
        if (referenceCount > 0) {
            throw new Error(
                `${referenceCount} SSO client${referenceCount === 1 ? "" : "s"} still reference${referenceCount === 1 ? "s" : ""} this app. `
                + "Unlink them first — deleting it here would widen what they are told about each user, not narrow it.",
            );
        }
        delete this.apps[appId];
        await this.persist();
    }

    private assertSlugFree(slug: string, exceptId: string | null): void {
        if (Object.values(this.apps).some((a) => a.id !== exceptId && a.slug === slug)) {
            throw new Error(`Another app already uses the name "${slug}"`);
        }
    }

    private async persist(): Promise<void> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await writeFileAtomic(this.file, JSON.stringify(this.apps, null, 2));
    }
}

function assertName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) {
        throw new Error("App name is required");
    }
    return trimmed;
}

/** One lowercase namespace segment. It becomes `app.<slug>.*`, so anything with
 *  a dot or a space would produce nodes that silently match nothing. */
function assertSlug(slug: string): string {
    const value = slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
        throw new Error(`Invalid app id: "${slug}". Use one lowercase segment, e.g. "immich".`);
    }
    return value;
}

/** Role names are the leaf of `app.<slug>.<role>`, so they carry the same
 *  restriction as the slug, and duplicates are dropped rather than rejected. */
function assertRoles(roles: readonly string[]): string[] {
    const out: string[] = [];
    for (const raw of roles) {
        const role = raw.trim().toLowerCase();
        if (!role) {
            continue;
        }
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(role)) {
            throw new Error(`Invalid role name: "${raw}". Use one lowercase segment, e.g. "admin".`);
        }
        if (!out.includes(role)) {
            out.push(role);
        }
    }
    return out;
}
