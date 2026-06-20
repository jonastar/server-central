import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { Role, UserInfo } from "@central/shared";
import { CONFIG_DIR } from "./config";

/** Sessions older than this (since last use) are rejected and pruned. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface UserRecord {
    id: string;
    username: string;
    passwordHash: string;
    role: Role;
    createdAt: number;
}

interface SessionRecord {
    userId: string;
    createdAt: number;
    lastSeenAt: number;
}

/** Resolved per-request auth, threaded into handler methods that need it. */
export interface AuthContext {
    token: string | null;
    user: UserInfo | null;
}

function toUserInfo(rec: UserRecord): UserInfo {
    return { id: rec.id, username: rec.username, role: rec.role, createdAt: rec.createdAt };
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
    private readonly usersFile: string;
    private readonly sessionsFile: string;

    constructor(dataDir: string = CONFIG_DIR) {
        this.usersFile = path.join(dataDir, "users.json");
        this.sessionsFile = path.join(dataDir, "sessions.json");
    }

    async init(): Promise<void> {
        this.users = await readJson<Record<string, UserRecord>>(this.usersFile);
        this.sessions = await readJson<Record<string, SessionRecord>>(this.sessionsFile);
        this.dummyHash = await Bun.password.hash(randomBytes(16).toString("hex"));
        await this.pruneExpired();
    }

    /** True until the first (owner) account is created. */
    needsSetup(): boolean {
        return Object.keys(this.users).length === 0;
    }

    /** Create the first account. Fails if any user already exists. */
    async setupOwner(username: string, password: string): Promise<{ token: string; user: UserInfo }> {
        if (!this.needsSetup()) throw new Error("Setup already completed");
        const user = await this.createUser(username, password, "owner");
        const token = await this.createSession(user.id);
        return { token, user };
    }

    async login(username: string, password: string): Promise<{ token: string; user: UserInfo }> {
        const rec = Object.values(this.users).find((u) => u.username === normalizeUsername(username));
        // Verify against a dummy hash when the user is unknown to keep timing uniform.
        const ok = await Bun.password.verify(password, rec?.passwordHash ?? this.dummyHash);
        if (!rec || !ok) throw new Error("Invalid username or password");
        const token = await this.createSession(rec.id);
        return { token, user: toUserInfo(rec) };
    }

    async logout(token: string | null): Promise<void> {
        if (token && this.sessions[token]) {
            delete this.sessions[token];
            await this.persistSessions();
        }
    }

    /** Resolve a bearer token to its user, refreshing the session's last-seen. */
    async authenticate(token: string | null): Promise<UserInfo | null> {
        if (!token) return null;
        const session = this.sessions[token];
        if (!session) return null;
        if (Date.now() - session.lastSeenAt > SESSION_TTL_MS) {
            delete this.sessions[token];
            await this.persistSessions();
            return null;
        }
        const rec = this.users[session.userId];
        if (!rec) return null;
        session.lastSeenAt = Date.now();
        // Persist last-seen lazily; a missed write only shortens the session window.
        this.persistSessions().catch(() => { /* best-effort */ });
        return toUserInfo(rec);
    }

    private async createUser(username: string, password: string, role: Role): Promise<UserInfo> {
        const name = normalizeUsername(username);
        if (!name) throw new Error("Username is required");
        if (password.length < 8) throw new Error("Password must be at least 8 characters");
        if (Object.values(this.users).some((u) => u.username === name)) {
            throw new Error("Username already taken");
        }
        const rec: UserRecord = {
            id: randomUUID(),
            username: name,
            passwordHash: await Bun.password.hash(password),
            role,
            createdAt: Date.now(),
        };
        this.users[rec.id] = rec;
        await this.persistUsers();
        return toUserInfo(rec);
    }

    private async createSession(userId: string): Promise<string> {
        const token = randomBytes(32).toString("base64url");
        this.sessions[token] = { userId, createdAt: Date.now(), lastSeenAt: Date.now() };
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
        if (changed) await this.persistSessions();
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
    await fs.writeFile(file, JSON.stringify(value, null, 2));
}
