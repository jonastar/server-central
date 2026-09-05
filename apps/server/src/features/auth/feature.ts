import type { Permission, RoleDef, UserDetail, UserInfo } from "@central/shared";
import type { AuthContext, AuthStore } from "../../auth";
import type { RoleStore } from "../../roles";
import { defineFeature } from "../../feature";

// The AuthStore itself stays at src/auth.ts: it's cross-cutting infra, not this
// feature's private state — the HTTP layer authenticates *every* request through
// it, and system-users reads the OS-account mapping off it. This file is only the
// feature's slice of the API, same split as servers/ over fleet.ts.

export const createAuthFeature = (auth: AuthStore, roles: RoleStore) => defineFeature({
    id: "auth",
    name: "Accounts",
    description: "Local user accounts, sessions, roles, and permission grants.",
    experimental: false,
    ops: {
        // ---- Session (getAuthState/setupOwner/login are the PUBLIC_COMMANDS) ----

        async getState(_data, ctx?: AuthContext) {
            return { needsSetup: auth.needsSetup(), user: ctx?.user ?? null };
        },

        async setupOwner(data, ctx?: AuthContext) {
            return auth.setupOwner(data.username, data.password, ctx?.ip ?? null, ctx?.userAgent ?? null);
        },

        async login(data, ctx?: AuthContext) {
            return auth.login(data.username, data.password, ctx?.ip ?? null, ctx?.userAgent ?? null);
        },

        async logout(_data, ctx?: AuthContext) {
            await auth.logout(ctx?.token ?? null);
        },

        async me(_data, ctx?: AuthContext) {
            if (!ctx?.user) {
                throw new Error("Not authenticated");
            }
            return ctx.user;
        },

        // ---- User administration (panel.users.*, declared above) ---------------

        async listUsers(_data, ctx?: AuthContext) {
            return auth.listUsers();
        },

        async createUser(data) {
            return auth.addUser(data.username, data.password, data.roleIds);
        },

        async deleteUser(data, ctx?: AuthContext) {
            await auth.deleteUser(data.userId, ctx!.user!.id);
        },

        async setUserRoles(data) {
            await auth.setUserRoles(data.userId, data.roleIds);
        },

        async getUserDetail(data, ctx?: AuthContext) {
            return auth.getUserDetail(data.userId, ctx!.token);
        },

        async revokeUserSession(data, ctx?: AuthContext) {
            await auth.revokeSession(data.userId, data.sessionId, ctx!.token);
        },

        async adminSetPassword(data, ctx?: AuthContext) {
            await auth.adminSetPassword(data.userId, data.password);
        },

        async setUserSystemUser(data, ctx?: AuthContext) {
            await auth.setSystemUser(data.userId, data.systemUser);
        },

        async setUserPermissions(data) {
            await auth.setPermissions(data.userId, data.permissions);
        },

        // ---- Roles (panel.roles.*) ---------------------------------------------

        async listRoles() {
            return roles.list();
        },

        async createRole(data) {
            return roles.create(data.name, data.description, data.permissions);
        },

        async updateRole(data) {
            await roles.update(data.role);
        },

        async resetRole(data) {
            return roles.resetToSeed(data.roleId);
        },

        async deleteRole(data) {
            // The store refuses while anyone still holds it, rather than
            // stripping the role from them with no record of what they had.
            await roles.delete(data.roleId, auth.countRoleHolders(data.roleId));
        },
    },
});


