import type { AssignableRole, UserDetail, UserInfo } from "@central/shared";
import { requireOwner, type AuthContext, type AuthStore } from "../../auth";
import type { Feature, FeatureApiHandlers } from "../../feature";

// The AuthStore itself stays at src/auth.ts: it's cross-cutting infra, not this
// feature's private state — the HTTP layer authenticates *every* request through
// it, and system-users reads the OS-account mapping off it. This file is only the
// feature's slice of the API, same split as servers/ over fleet.ts.

export function createAuthFeature(auth: AuthStore): Feature<AuthOps> {
    return {
        descriptor: {
            id: "auth",
            name: "Accounts",
            description: "Local user accounts, sessions, and role assignment.",
            experimental: false,
        },
        apiHandlers() {
            return authApiHandlers(auth);
        },
    };
}

export type AuthOps = "getAuthState" | "setupOwner" | "login" | "logout" | "me"
    | "listUsers" | "createUser" | "deleteUser" | "updateUserRole" | "getUserDetail"
    | "revokeUserSession" | "adminSetPassword" | "setUserSystemUser";

export function authApiHandlers(auth: AuthStore): FeatureApiHandlers<AuthOps> {
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

        // ---- User administration (owner-only) ----------------------------------

        async handleListUsers(_data: void, ctx?: AuthContext): Promise<UserInfo[]> {
            requireOwner(ctx);
            return auth.listUsers();
        },

        async handleCreateUser(data: { username: string; password: string; role: AssignableRole }, ctx?: AuthContext): Promise<UserInfo> {
            requireOwner(ctx);
            return auth.addUser(data.username, data.password, data.role);
        },

        async handleDeleteUser(data: { userId: string }, ctx?: AuthContext): Promise<void> {
            requireOwner(ctx);
            await auth.deleteUser(data.userId, ctx!.user!.id);
        },

        async handleUpdateUserRole(data: { userId: string; role: AssignableRole }, ctx?: AuthContext): Promise<void> {
            requireOwner(ctx);
            await auth.updateUserRole(data.userId, data.role);
        },

        async handleGetUserDetail(data: { userId: string }, ctx?: AuthContext): Promise<UserDetail> {
            requireOwner(ctx);
            return auth.getUserDetail(data.userId, ctx!.token);
        },

        async handleRevokeUserSession(data: { userId: string; sessionId: string }, ctx?: AuthContext): Promise<void> {
            requireOwner(ctx);
            await auth.revokeSession(data.userId, data.sessionId, ctx!.token);
        },

        async handleAdminSetPassword(data: { userId: string; password: string }, ctx?: AuthContext): Promise<void> {
            requireOwner(ctx);
            await auth.adminSetPassword(data.userId, data.password);
        },

        async handleSetUserSystemUser(data: { userId: string; systemUser: string | null }, ctx?: AuthContext): Promise<void> {
            requireOwner(ctx);
            await auth.setSystemUser(data.userId, data.systemUser);
        },
    };
}
