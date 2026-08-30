import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Permission, RoleDef } from "@central/shared";
import { PANEL_PERMISSION_IDS, SEED_ROLES, isValidPermission, seedRoleFor } from "@central/shared";
import { CONFIG_DIR, writeFileAtomic } from "./config";

/**
 * File-backed role definitions (`.sc-data/roles.json`), seeded from
 * {@link SEED_ROLES} on first run and owned by the installation thereafter.
 *
 * Seeded rather than code-defined so an update can never widen an existing
 * role: a permission node added in a later release lands in no role until
 * someone puts it there. That is the fail-closed direction and the same
 * reasoning as sensitive nodes not being covered by wildcards. The trade — a new
 * capability nobody notices — is answered by `unassignedPermissions`, which the
 * Roles screen surfaces.
 *
 * Lives beside `AuthStore` rather than inside the auth feature for the same
 * reason that does: computing a user's effective permissions needs it, and that
 * happens on every authenticated request.
 */
export class RoleStore {
    private roles: Record<string, RoleDef> = {};
    private readonly file: string;

    constructor(dataDir: string = CONFIG_DIR) {
        this.file = path.join(dataDir, "roles.json");
    }

    async init(): Promise<void> {
        try {
            this.roles = JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, RoleDef>;
        } catch {
            this.roles = {};
        }
        if (Object.keys(this.roles).length === 0) {
            for (const seed of SEED_ROLES) {
                this.roles[seed.id] = { ...seed, permissions: [...seed.permissions] };
            }
            await this.persist();
            console.log(`Seeded ${SEED_ROLES.length} roles at ${this.file}`);
        }
    }

    list(): RoleDef[] {
        return Object.values(this.roles);
    }

    get(id: string): RoleDef | null {
        return this.roles[id] ?? null;
    }

    /** The roles a user holds, skipping ids that no longer exist — a deleted
     *  role must degrade to "grants nothing", never to an error that locks the
     *  holder out of every request. */
    resolve(roleIds: readonly string[]): RoleDef[] {
        return roleIds.map((id) => this.roles[id]).filter((r): r is RoleDef => r !== undefined);
    }

    async create(name: string, description: string, permissions: Permission[]): Promise<RoleDef> {
        const role: RoleDef = {
            id: randomUUID(),
            name: requireName(name),
            description: description.trim(),
            permissions: validatePermissions(permissions),
        };
        this.roles[role.id] = role;
        await this.persist();
        return role;
    }

    async update(role: RoleDef): Promise<void> {
        const existing = this.roles[role.id];
        if (!existing) {
            throw new Error("Role not found");
        }
        this.roles[role.id] = {
            ...existing,
            name: requireName(role.name),
            description: role.description.trim(),
            permissions: validatePermissions(role.permissions),
        };
        await this.persist();
    }

    /** `heldBy` is how many accounts still reference this role. Deleting a role
     *  out from under its holders would silently drop their access with no
     *  record of what they had, so it's refused rather than cascaded. */
    async delete(roleId: string, heldBy: number): Promise<void> {
        if (!this.roles[roleId]) {
            return;
        }
        if (heldBy > 0) {
            throw new Error(`${heldBy} account${heldBy === 1 ? "" : "s"} still hold this role — remove it from them first`);
        }
        delete this.roles[roleId];
        await this.persist();
    }

    /**
     * Restore a seeded role to what shipped, recreating it if it was deleted.
     *
     * Two situations produce the same symptom and this fixes both: someone edited
     * the role into a state they'd rather undo, and a later release added a
     * permission that never reached this installation because updates
     * deliberately don't widen existing roles. Custom roles have no default to
     * return to, so they're refused rather than silently ignored.
     */
    async resetToSeed(roleId: string): Promise<RoleDef> {
        const seed = seedRoleFor(roleId);
        if (!seed) {
            throw new Error("Only the roles Server Central ships have a default to reset to");
        }
        this.roles[seed.id] = { ...seed, permissions: [...seed.permissions] };
        await this.persist();
        return this.roles[seed.id];
    }

    private async persist(): Promise<void> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await writeFileAtomic(this.file, JSON.stringify(this.roles, null, 2));
    }
}

function requireName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) {
        throw new Error("Role name is required");
    }
    return trimmed;
}

/**
 * Roles hold `panel.*` nodes, and unlike a user's ad-hoc grants those are
 * checked against the registry: a role is a curated bundle someone assembled
 * from a list, so an unknown `panel.` node is a typo rather than forward
 * compatibility. `app.*` stays free — the app's role names aren't ours to know.
 */
function validatePermissions(permissions: readonly Permission[]): Permission[] {
    const out: Permission[] = [];
    for (const raw of permissions) {
        const node = raw.trim();
        if (!node) {
            continue;
        }
        if (!isValidPermission(node)) {
            throw new Error(`Invalid permission node: ${node}`);
        }
        if (node.startsWith("panel.") && !node.endsWith(".*") && !PANEL_PERMISSION_IDS.includes(node as never)) {
            throw new Error(`Unknown permission node: ${node}`);
        }
        if (!out.includes(node)) {
            out.push(node);
        }
    }
    return out;
}
