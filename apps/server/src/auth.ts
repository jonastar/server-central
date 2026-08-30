import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { Permission, UserDetail, UserInfo, UserSession } from "@central/shared";
import { effectivePermissions, isValidPermission } from "@central/shared";
import type { RoleStore } from "./roles";
import { CONFIG_DIR, writeFileAtomic } from "./config";
import { assertSystemUsername } from "./features/system-users/system-users";

/** Sessions older than this (since last use) are rejected and pruned. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface UserRecord {
    id: string;
    username: string;
    passwordHash: string;
    /** The first account. Bypasses permission checks entirely. */
    isOwner?: boolean;
    /** Roles held, by id — additive, in any number. */
    roleIds?: string[];
    /** Pre-multi-role records carried a single role name here. Read once at
     *  startup and migrated to `isOwner`/`roleIds`; see `migrateRoles`. */
    role?: string;
    createdAt: number;
    /** Mapped OS account (see UserInfo.systemUser). Absent on older records. */
    systemUser?: string | null;
    /** Ad-hoc permission nodes on top of the role's bundle. Absent on older
     *  records, which is the same as none — the role alone then decides, so
     *  existing accounts keep exactly the access their role implies. */
    extraPermissions?: Permission[];
}

interface SessionRecord {
    id: string;
    userId: string;
    createdAt: number;
    lastSeenAt: number;
    ip: string | null;
    userAgent: string | null;
}

/** Resolved per-request auth, threaded into handler methods that need it. */
export interface AuthContext {
    token: string | null;
    user: UserInfo | null;
    /** Source IP of the request, used to rate-limit login attempts. */
    ip: string | null;
    /** `User-Agent` request header, recorded on sessions for the admin sessions list. */
    userAgent: string | null;
}

/** Login throttle: after this many consecutive failures from one source, further
 *  attempts are blocked for the cooldown window. */
const MAX_LOGIN_FAILURES = 10;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;

function toUserInfo(rec: UserRecord, roles: RoleStore): UserInfo {
    const roleIds = rec.roleIds ?? [];
    return {
        id: rec.id,
        username: rec.username,
        isOwner: rec.isOwner === true,
        roleIds,
        // Effective set, merged on read rather than stored: editing a role takes
        // effect for its holders immediately, and there's no second copy to
        // drift. Unknown role ids resolve to nothing rather than throwing.
        permissions: effectivePermissions(rec.isOwner === true, roles.resolve(roleIds), rec.extraPermissions ?? []),
        createdAt: rec.createdAt,
        systemUser: rec.systemUser ?? null,
    };
}

/**
 * File-backed user accounts and opaque session tokens. Passwords are hashed with
 * Bun's argon2id (`Bun.password`). Tokens are random 256-bit strings stored in
 * `.sc-data/sessions.json`; the browser keeps one in localStorage and sends it
 * as a bearer token (and as a `?token=` query param on WebSocket upgrades).
 */
export class AuthStore {
    private users: Record<string, UserRecord> = {};
    private sessions: Record<string, SessionRecord> = {};
    // A real argon2id hash of a random secret, used to equalize login timing for
    // unknown usernames so they can't be distinguished from wrong passwords.
    private dummyHash = "";
    // Consecutive failed logins per source (IP, or username when no IP), for throttling.
    private loginFailures = new Map<string, { count: number; blockedUntil: number }>();
    private readonly usersFile: string;
    private readonly sessionsFile: string;

    constructor(private readonly roles: RoleStore, dataDir: string = CONFIG_DIR) {
        this.usersFile = path.join(dataDir, "users.json");
        this.sessionsFile = path.join(dataDir, "sessions.json");
    }

    async init(): Promise<void> {
        this.users = await readJson<Record<string, UserRecord>>(this.usersFile);
        console.log(this.users);
        this.sessions = await readJson<Record<string, SessionRecord>>(this.sessionsFile);
        this.dummyHash = await Bun.password.hash(randomBytes(16).toString("hex"));
        await this.migrateRoles();
        await this.backfillSessionIds();
        await this.pruneExpired();
    }

    /**
     * Carry pre-multi-role records over: a single `role` name becomes an owner
     * flag or a one-element `roleIds`.
     *
     * The seeded role ids match the old names exactly (`viewer`, `operator`,
     * `admin`), which is why this is a rename rather than a mapping table. The
     * old `"none"` and the owner both become an empty role list — for the owner
     * because it bypasses checks anyway, and holding a role would imply it could
     * be taken away.
     */
    private async migrateRoles(): Promise<void> {
        let changed = false;
        for (const rec of Object.values(this.users)) {
            if (rec.roleIds !== undefined || rec.role === undefined) {
                continue;
            }
            rec.isOwner = rec.role === "owner";
            rec.roleIds = rec.role === "owner" || rec.role === "none" ? [] : [rec.role];
            delete rec.role;
            changed = true;
        }
        if (changed) {
            await this.persistUsers();
            console.log("Migrated user records to multi-role");
        }
    }

    /** Sessions written before `id`/`ip`/`userAgent` existed are missing them —
     *  assign a fresh id once so the admin sessions list has a stable key. */
    private async backfillSessionIds(): Promise<void> {
        let changed = false;
        for (const session of Object.values(this.sessions)) {
            if (!session.id) {
                session.id = randomUUID();
                session.ip ??= null;
                session.userAgent ??= null;
                changed = true;
            }
        }
        if (changed) {
            await this.persistSessions();
        }
    }

    /** True until the first (owner) account is created. */
    needsSetup(): boolean {
        return Object.keys(this.users).length === 0;
    }

    /** Create the first account. Fails if any user already exists. */
    async setupOwner(username: string, password: string, ip: string | null = null, userAgent: string | null = null): Promise<{ token: string; user: UserInfo }> {
        if (!this.needsSetup()) {
            throw new Error("Setup already completed");
        }
        const user = await this.createUser(username, password, [], true);
        const token = await this.createSession(user.id, ip, userAgent);
        return { token, user };
    }

    async login(username: string, password: string, ip: string | null = null, userAgent: string | null = null): Promise<{ token: string; user: UserInfo }> {
        const key = ip ?? normalizeUsername(username);
        const blocked = this.loginFailures.get(key);
        if (blocked && blocked.blockedUntil > Date.now()) {
            throw new Error("Too many failed attempts — try again later");
        }

        const rec = Object.values(this.users).find((u) => u.username === normalizeUsername(username));
        // Verify against a dummy hash when the user is unknown to keep timing uniform.
        const ok = await Bun.password.verify(password, rec?.passwordHash ?? this.dummyHash);
        if (!rec || !ok) {
            this.recordLoginFailure(key);
            throw new Error("Invalid username or password");
        }
        this.loginFailures.delete(key);
        const token = await this.createSession(rec.id, ip, userAgent);
        return { token, user: toUserInfo(rec, this.roles) };
    }

    /** Count a failed login for `key`, arming a cooldown once the threshold is hit. */
    private recordLoginFailure(key: string): void {
        const entry = this.loginFailures.get(key) ?? { count: 0, blockedUntil: 0 };
        entry.count += 1;
        if (entry.count >= MAX_LOGIN_FAILURES) {
            entry.blockedUntil = Date.now() + LOGIN_BLOCK_MS;
            entry.count = 0;
        }
        this.loginFailures.set(key, entry);
    }

    async logout(token: string | null): Promise<void> {
        if (token && this.sessions[token]) {
            delete this.sessions[token];
            await this.persistSessions();
        }
    }

    /** All accounts, for the owner-only Users admin screen. */
    listUsers(): UserInfo[] {
        return Object.values(this.users).map((r) => toUserInfo(r, this.roles));
    }

    /** Look up a user directly by id — used by the OIDC token/userinfo endpoints,
     *  which authenticate via a client credential or an OIDC access token rather
     *  than a session bearer token. */
    getUserById(userId: string): UserInfo | null {
        const rec = this.users[userId];
        return rec ? toUserInfo(rec, this.roles) : null;
    }

    /** Create an additional account. Gated by `panel.users.admin` on the caller. */
    async addUser(username: string, password: string, roleIds: string[]): Promise<UserInfo> {
        return this.createUser(username, password, this.knownRoleIds(roleIds));
    }

    /** Remove an account. The owner is a singleton and can't be deleted, nor can a
     *  caller delete their own account (would strand the session mid-request). */
    async deleteUser(userId: string, callerId: string): Promise<void> {
        const rec = this.users[userId];
        if (!rec) {
            return;
        }
        if (rec.isOwner) {
            throw new Error("The owner account can't be deleted");
        }
        if (userId === callerId) {
            throw new Error("You can't delete your own account");
        }
        delete this.users[userId];
        await this.persistUsers();
        await this.deleteSessionsForUser(userId);
    }

    /** Replace the set of roles an account holds. The owner holds none by
     *  design — it bypasses checks, and a role it could lose would be a way to
     *  lock the installation out of its own admin screens. */
    async setUserRoles(userId: string, roleIds: string[]): Promise<void> {
        const rec = this.users[userId];
        if (!rec) {
            throw new Error("User not found");
        }
        if (rec.isOwner) {
            throw new Error("The owner holds every permission and can't be assigned roles");
        }
        rec.roleIds = this.knownRoleIds(roleIds);
        await this.persistUsers();
    }

    /** How many accounts hold a given role — what `deleteRole` refuses on. */
    countRoleHolders(roleId: string): number {
        return Object.values(this.users).filter((u) => (u.roleIds ?? []).includes(roleId)).length;
    }

    /** Reject role ids that don't exist, rather than storing a dangling
     *  reference that silently grants nothing. */
    private knownRoleIds(roleIds: readonly string[]): string[] {
        const out: string[] = [];
        for (const id of roleIds) {
            if (!this.roles.get(id)) {
                throw new Error(`Unknown role: ${id}`);
            }
            if (!out.includes(id)) {
                out.push(id);
            }
        }
        return out;
    }

    /** Replace a user's ad-hoc permission grants (the role bundle is untouched).
     *  Nodes are shape-validated only: `panel.*` could be checked against the
     *  registry, but `app.*` deliberately has none, and rejecting an app role
     *  because the app isn't installed yet would be wrong. */
    async setPermissions(userId: string, permissions: Permission[]): Promise<void> {
        const rec = this.users[userId];
        if (!rec) {
            throw new Error("User not found");
        }
        const cleaned: Permission[] = [];
        for (const raw of permissions) {
            const node = raw.trim();
            if (!node) {
                continue;
            }
            if (!isValidPermission(node)) {
                throw new Error(`Invalid permission node: ${node}`);
            }
            if (!cleaned.includes(node)) {
                cleaned.push(node);
            }
        }
        rec.extraPermissions = cleaned;
        await this.persistUsers();
    }

    /** Map a user to an OS account on managed hosts (null clears the mapping).
     *  The name is validated for shape only — whether it exists is per-host, and
     *  the terminal fails with a clear message on hosts where it doesn't. */
    async setSystemUser(userId: string, systemUser: string | null): Promise<void> {
        const rec = this.users[userId];
        if (!rec) {
            throw new Error("User not found");
        }
        const name = systemUser?.trim() || null;
        if (name) {
            assertSystemUsername(name);
        }
        rec.systemUser = name;
        await this.persistUsers();
    }

    /** Sessions + last-active for the admin user-detail view. `currentToken` (the
     *  caller's own bearer token) flags which session is "this one". */
    getUserDetail(userId: string, currentToken: string | null): UserDetail {
        const rec = this.users[userId];
        if (!rec) {
            throw new Error("User not found");
        }
        const sessions: UserSession[] = Object.entries(this.sessions)
            .filter(([, s]) => s.userId === userId)
            .map(([token, s]) => ({
                id: s.id,
                createdAt: s.createdAt,
                lastSeenAt: s.lastSeenAt,
                ip: s.ip,
                userAgent: s.userAgent,
                current: token === currentToken,
            }))
            .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
        return {
            ...toUserInfo(rec, this.roles),
            extraPermissions: rec.extraPermissions ?? [],
            sessions,
            lastActiveAt: sessions[0]?.lastSeenAt ?? null,
        };
    }

    /** Revoke one of a user's sessions (e.g. an admin force-logging-out a stale
     *  browser). Refuses to revoke the caller's own current session — that's what
     *  /logout is for, and this avoids confusingly booting yourself mid-request. */
    async revokeSession(userId: string, sessionId: string, currentToken: string | null): Promise<void> {
        const entry = Object.entries(this.sessions).find(([, s]) => s.userId === userId && s.id === sessionId);
        if (!entry) {
            throw new Error("Session not found");
        }
        const [token] = entry;
        if (token === currentToken) {
            throw new Error("Can't revoke your own current session this way — log out instead");
        }
        delete this.sessions[token];
        await this.persistSessions();
    }

    /** Owner-driven password reset. Revokes all of the target user's sessions so
     *  a reset takes effect immediately rather than leaving old sessions live. */
    async adminSetPassword(userId: string, password: string): Promise<void> {
        const rec = this.users[userId];
        if (!rec) {
            throw new Error("User not found");
        }
        if (password.length < 8) {
            throw new Error("Password must be at least 8 characters");
        }
        rec.passwordHash = await Bun.password.hash(password);
        await this.persistUsers();
        await this.deleteSessionsForUser(userId);
    }

    private async deleteSessionsForUser(userId: string): Promise<void> {
        let changed = false;
        for (const [token, session] of Object.entries(this.sessions)) {
            if (session.userId === userId) {
                delete this.sessions[token];
                changed = true;
            }
        }
        if (changed) {
            await this.persistSessions();
        }
    }

    /** Resolve a bearer token to its user, refreshing the session's last-seen. */
    async authenticate(token: string | null): Promise<UserInfo | null> {
        if (!token) {
            return null;
        }
        const session = this.sessions[token];
        if (!session) {
            return null;
        }
        if (Date.now() - session.lastSeenAt > SESSION_TTL_MS) {
            delete this.sessions[token];
            await this.persistSessions();
            return null;
        }
        const rec = this.users[session.userId];
        if (!rec) {
            return null;
        }
        session.lastSeenAt = Date.now();
        // Persist last-seen lazily; a missed write only shortens the session window.
        this.persistSessions().catch(() => { /* best-effort */ });
        return toUserInfo(rec, this.roles);
    }

    private async createUser(username: string, password: string, roleIds: string[], isOwner = false): Promise<UserInfo> {
        const name = normalizeUsername(username);
        if (!name) {
            throw new Error("Username is required");
        }
        if (password.length < 8) {
            throw new Error("Password must be at least 8 characters");
        }
        if (Object.values(this.users).some((u) => u.username === name)) {
            throw new Error("Username already taken");
        }
        const rec: UserRecord = {
            id: randomUUID(),
            username: name,
            passwordHash: await Bun.password.hash(password),
            isOwner,
            roleIds,
            createdAt: Date.now(),
        };
        this.users[rec.id] = rec;
        await this.persistUsers();
        return toUserInfo(rec, this.roles);
    }

    private async createSession(userId: string, ip: string | null = null, userAgent: string | null = null): Promise<string> {
        const token = randomBytes(32).toString("base64url");
        const now = Date.now();
        this.sessions[token] = { id: randomUUID(), userId, createdAt: now, lastSeenAt: now, ip, userAgent };
        await this.persistSessions();
        return token;
    }

    private async pruneExpired(): Promise<void> {
        const now = Date.now();
        let changed = false;
        for (const [token, session] of Object.entries(this.sessions)) {
            if (now - session.lastSeenAt > SESSION_TTL_MS || !this.users[session.userId]) {
                delete this.sessions[token];
                changed = true;
            }
        }
        if (changed) {
            await this.persistSessions();
        }
    }

    private async persistUsers(): Promise<void> {
        await writeJson(this.usersFile, this.users);
    }

    private async persistSessions(): Promise<void> {
        await writeJson(this.sessionsFile, this.sessions);
    }
}

function normalizeUsername(username: string): string {
    return username.trim().toLowerCase();
}

async function readJson<T>(file: string): Promise<T> {
    try {
        return JSON.parse(await fs.readFile(file, "utf8")) as T;
    } catch {
        return {} as T;
    }
}

async function writeJson(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(value, null, 2));
}

/** Throws unless the caller is the owner.
 *
 *  Per-operation gating is no longer this function's job — the permission
 *  registry in `@central/shared` classifies every operation and the dispatcher
 *  enforces it. Kept for the few places that are owner-only *within* an
 *  already-permitted operation. */
export function requireOwner(ctx?: AuthContext): void {
    if (!ctx?.user?.isOwner) {
        throw new Error("Only the owner can do this");
    }
}
