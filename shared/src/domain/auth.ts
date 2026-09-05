import type { Permission, RoleDef } from "../permissions";

// ---- Auth & users ------------------------------------------------------------
//
// A role is a **named, editable bundle of permission nodes** (see
// ./permissions.ts), not a rung on a ladder that implies the ones below it.
// Enforcement reads permissions; roles exist so the Users screen isn't a
// thirty-checkbox tree. A user holds any number of them and the grants union —
// which needs no precedence rules, because the model is grant-only.

export interface UserInfo {
    id: string;
    username: string;
    /** The first account, a singleton, never deletable. Bypasses every
     *  permission check — see `userCan`. Not a role: a role you could remove
     *  from yourself is a lockout waiting to happen. */
    isOwner: boolean;
    /** Roles held, by id. Any number; their grants union together. An empty
     *  list is the floor — signs in, holds `app.*` grants for SSO and the proxy
     *  gate, reaches nothing in the control plane. */
    roleIds: string[];
    /** Everything this user effectively holds — the role's bundle plus any
     *  ad-hoc grants. Computed, never stored; `["*"]` for the owner, which is
     *  display only (the owner bypasses the check, see `userCan`). Sent to the
     *  client so the UI can hide what the server would refuse anyway. */
    permissions: Permission[];
    createdAt: number;
    /** OS account this user's terminal runs as on managed hosts. Null means
     *  unmapped: owner/admin fall back to the agent's own user (root), while
     *  operator/viewer are denied a terminal entirely. */
    systemUser: string | null;
}

/** A single active login session for a user, surfaced on the admin user-detail view. */
export interface UserSession {
    id: string;
    createdAt: number;
    lastSeenAt: number;
    ip: string | null;
    userAgent: string | null;
    /** True when this is the session the requesting admin is themselves using. */
    current: boolean;
}

/** Expanded view of a user shown when an admin drills into a row in the Users tab. */
export interface UserDetail extends UserInfo {
    /** Just the ad-hoc grants, unmerged — what the permission editor edits.
     *  `UserInfo.permissions` above is the merged result and is read-only. */
    extraPermissions: Permission[];
    sessions: UserSession[];
    /** Most recent `lastSeenAt` across all sessions, or null if the user has never logged in. */
    lastActiveAt: number | null;
}


/** Sessions, roles, and user administration. `getAuthState`/`setupOwner`/`login`
 *  require no session; the rest do. */
export interface AuthOperations {
    getState: { data: void; response: { needsSetup: boolean; user: UserInfo | null } };
    setupOwner: { data: { username: string; password: string }; response: { token: string; user: UserInfo } };
    login: { data: { username: string; password: string }; response: { token: string; user: UserInfo } };
    logout: { data: void; response: void };
    me: { data: void; response: UserInfo };

    // Roles — editable bundles of permissions, seeded on first run.
    listRoles: { data: void; response: RoleDef[] };
    createRole: { data: { name: string; description: string; permissions: Permission[] }; response: RoleDef };
    updateRole: { data: { role: RoleDef }; response: void };
    // Refused while any account still holds the role, rather than silently
    // stripping it from them.
    deleteRole: { data: { roleId: string }; response: void };
    // Restore a seeded role to the definition that shipped — recreating it if it
    // was deleted. Also how a seeded role picks up permissions added in a later
    // release, since an update never widens one on its own.
    resetRole: { data: { roleId: string }; response: RoleDef };

    // Users (owner-only)
    listUsers: { data: void; response: UserInfo[] };
    createUser: { data: { username: string; password: string; roleIds: string[] }; response: UserInfo };
    deleteUser: { data: { userId: string }; response: void };
    setUserRoles: { data: { userId: string; roleIds: string[] }; response: void };
    /** Sessions + last-active, fetched on demand when a row expands in the Users tab. */
    getUserDetail: { data: { userId: string }; response: UserDetail };
    revokeUserSession: { data: { userId: string; sessionId: string }; response: void };
    // Resets a user's password; revokes all of that user's sessions so the new
    // password takes effect immediately.
    adminSetPassword: { data: { userId: string; password: string }; response: void };
    /** Map a user to an OS account (null clears the mapping). See UserInfo.systemUser. */
    setUserSystemUser: { data: { userId: string; systemUser: string | null }; response: void };
    // Ad-hoc permission nodes granted on top of the user's role bundle — how an
    // account reaches one app and nothing else (role `none` + `app.immich.user`).
    setUserPermissions: { data: { userId: string; permissions: Permission[] }; response: void };
}
