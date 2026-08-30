import type { Permission, RoleDef, UserDetail, UserInfo } from "@central/shared";
import type { AuthContext, AuthStore } from "../../auth";
import type { RoleStore } from "../../roles";
import type { Feature, FeatureApiHandlers } from "../../feature";

// The AuthStore itself stays at src/auth.ts: it's cross-cutting infra, not this
// feature's private state — the HTTP layer authenticates *every* request through
// it, and system-users reads the OS-account mapping off it. This file is only the
// feature's slice of the API, same split as servers/ over fleet.ts.

export function createAuthFeature(auth: AuthStore, roles: RoleStore): Feature<AuthOps> {
    return {
        descriptor: {
            id: "auth",
            name: "Accounts",
            description: "Local user accounts, sessions, roles, and permission grants.",
            experimental: false,
        },
        apiHandlers() {
            return authApiHandlers(auth, roles);
        },
    };
}

export type AuthOps = "getAuthState" | "setupOwner" | "login" | "logout" | "me"
    | "listUsers" | "createUser" | "deleteUser" | "setUserRoles" | "getUserDetail"
    | "revokeUserSession" | "adminSetPassword" | "setUserSystemUser" | "setUserPermissions"
    | "listRoles" | "createRole" | "updateRole" | "deleteRole" | "resetRole";

export function authApiHandlers(auth: AuthStore, roles: RoleStore): FeatureApiHandlers<AuthOps> {
    return {
        // ---- Session (getAuthState/setupOwner/login are the PUBLIC_COMMANDS) ----

        async handleGetAuthState(_data: void, ctx?: AuthContext): Promise<{ needsSetup: boolean; user: UserInfo | null }> {
            return { needsSetup: auth.needsSetup(), user: ctx?.user ?? null };
        },

        async handleSetupOwner(data: { username: string; password: string }, ctx?: AuthContext): Promise<{ token: string; user: UserInfo }> {
            return auth.setupOwner(data.username, data.password, ctx?.ip ?? null, ctx?.userAgent ?? null);
        },

        async handleLogin(data: { username: string; password: string }, ctx?: AuthContext): Promise<{ token: string; user: UserInfo }> {
            return auth.login(data.username, data.password, ctx?.ip ?? null, ctx?.userAgent ?? null);
        },

        async handleLogout(_data: void, ctx?: AuthContext): Promise<void> {
            await auth.logout(ctx?.token ?? null);
        },

        async handleMe(_data: void, ctx?: AuthContext): Promise<UserInfo> {
            if (!ctx?.user) {
                throw new Error("Not authenticated");
            }
            return ctx.user;
        },

        // ---- User administration (panel.users.*, declared above) ---------------

        async handleListUsers(_data: void, ctx?: AuthContext): Promise<UserInfo[]> {
            return auth.listUsers();
        },

        async handleCreateUser(data: { username: string; password: string; roleIds: string[] }): Promise<UserInfo> {
            return auth.addUser(data.username, data.password, data.roleIds);
        },

        async handleDeleteUser(data: { userId: string }, ctx?: AuthContext): Promise<void> {
            await auth.deleteUser(data.userId, ctx!.user!.id);
        },

        async handleSetUserRoles(data: { userId: string; roleIds: string[] }): Promise<void> {
            await auth.setUserRoles(data.userId, data.roleIds);
        },

        async handleGetUserDetail(data: { userId: string }, ctx?: AuthContext): Promise<UserDetail> {
            return auth.getUserDetail(data.userId, ctx!.token);
        },

        async handleRevokeUserSession(data: { userId: string; sessionId: string }, ctx?: AuthContext): Promise<void> {
            await auth.revokeSession(data.userId, data.sessionId, ctx!.token);
        },

        async handleAdminSetPassword(data: { userId: string; password: string }, ctx?: AuthContext): Promise<void> {
            await auth.adminSetPassword(data.userId, data.password);
        },

        async handleSetUserSystemUser(data: { userId: string; systemUser: string | null }, ctx?: AuthContext): Promise<void> {
            await auth.setSystemUser(data.userId, data.systemUser);
        },

        async handleSetUserPermissions(data: { userId: string; permissions: Permission[] }): Promise<void> {
            await auth.setPermissions(data.userId, data.permissions);
        },

        // ---- Roles (panel.roles.*) ---------------------------------------------

        async handleListRoles(): Promise<RoleDef[]> {
            return roles.list();
        },

        async handleCreateRole(data: { name: string; description: string; permissions: Permission[] }): Promise<RoleDef> {
            return roles.create(data.name, data.description, data.permissions);
        },

        async handleUpdateRole(data: { role: RoleDef }): Promise<void> {
            await roles.update(data.role);
        },

        async handleResetRole(data: { roleId: string }): Promise<RoleDef> {
            return roles.resetToSeed(data.roleId);
        },

        async handleDeleteRole(data: { roleId: string }): Promise<void> {
            // The store refuses while anyone still holds it, rather than
            // stripping the role from them with no record of what they had.
            await roles.delete(data.roleId, auth.countRoleHolders(data.roleId));
        },
    };
}
