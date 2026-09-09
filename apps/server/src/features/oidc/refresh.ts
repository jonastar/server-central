import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CONFIG_DIR, writeFileAtomic } from "../../config";

/**
 * Refresh tokens — the first OIDC credential that has to survive a restart.
 *
 * Authorization codes are deliberately in-memory: single-use, 60 seconds, and a
 * restart mid-login just fails that attempt. A refresh token is the opposite. A
 * TV that has to re-run its pairing flow because the control plane restarted is
 * exactly the failure this exists to prevent, so these persist.
 *
 * Stored hashed, like client secrets and user passwords. A leaked file should
 * not be a set of working credentials, and nothing ever needs the original back
 * — presentation is a lookup, not a decryption.
 */

/** Long enough that the whole family is gone before anyone notices a theft, and
 *  short enough that a token abandoned on a decommissioned device stops working.
 *  Independent of SESSION_TTL_MS by design: this is its own session, decided in
 *  doc/idea_sign_in_methods.md §7 Q3. */
const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

/**
 * How long a spent token is remembered so that replaying it is recognisable.
 *
 * Reuse detection needs the spent link to still exist — delete it and a replay
 * is indistinguishable from a token that was never ours, which is refused but
 * does not revoke the chain. Keeping every spent link until the family expires
 * would mean one row per refresh (a device refreshing hourly for 60 days is
 * ~1440 rows), so they are kept only for a window instead. A token replayed
 * after that window is still refused; it just no longer takes the family with
 * it, which is an acceptable trade — theft is replayed promptly or not at all.
 */
const SPENT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface RefreshRecord {
    /** Shared by every token in a rotation chain, so reuse revokes all of them. */
    familyId: string;
    userId: string;
    clientId: string;
    scope: string;
    issuedAt: number;
    expiresAt: number;
    /** Set once the token has been exchanged. The row survives as a tombstone so
     *  a replay is recognisable rather than merely unknown; see SPENT_TTL_MS. */
    usedAt?: number;
}

/** The token as presented, and what it resolved to. */
export interface RefreshGrant {
    familyId: string;
    userId: string;
    clientId: string;
    scope: string;
}

/** Opaque random, like session tokens — never a JWT. A self-contained refresh
 *  token could not be revoked, which is the one thing it must support. */
function mint(): string {
    return randomBytes(32).toString("base64url");
}

/** Tokens are looked up by exact value, so a fast digest is the right tool:
 *  there is no low-entropy guess to slow down the way there is for a password. */
function digest(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

export class RefreshTokenStore {
    private tokens: Record<string, RefreshRecord> = {};
    private readonly file: string;

    constructor(dataDir: string = CONFIG_DIR) {
        this.file = path.join(dataDir, "oidc-refresh-tokens.json");
    }

    async init(): Promise<void> {
        try {
            this.tokens = JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, RefreshRecord>;
        } catch {
            this.tokens = {};
        }
        await this.pruneExpired();
    }

    /** Start a new rotation chain, at the end of an authorization_code exchange. */
    async issue(params: { userId: string; clientId: string; scope: string }): Promise<string> {
        return this.append(randomUUID(), params);
    }

    /**
     * Redeem a token and issue its replacement, atomically from the caller's
     * point of view: the presented token is always consumed, whether or not it
     * turns out to be valid.
     *
     * Rotation with reuse detection. A token is single-use; presenting one twice
     * means either a buggy client or a stolen token, and the two are
     * indistinguishable from here. The safe reading is theft, so the whole
     * family dies and both the thief and the legitimate holder are forced to
     * re-authorize. Losing a TV's pairing is an acceptable price for not leaving
     * a stolen token working indefinitely.
     */
    async rotate(token: string): Promise<{ grant: RefreshGrant; next: string } | { reused: true } | null> {
        const key = digest(token);
        const rec = this.tokens[key];
        if (!rec) {
            // Never ours, or spent long enough ago that the tombstone is gone.
            return null;
        }
        if (rec.usedAt !== undefined) {
            await this.revokeFamily(rec.familyId);
            return { reused: true };
        }
        if (rec.expiresAt < Date.now()) {
            delete this.tokens[key];
            await this.persist();
            return null;
        }
        rec.usedAt = Date.now();
        const next = await this.append(rec.familyId, rec);
        return { grant: { familyId: rec.familyId, userId: rec.userId, clientId: rec.clientId, scope: rec.scope }, next };
    }

    /** Revoke one token by value (RFC 7009). Takes the family with it: a client
     *  signing out means the whole chain should stop, not just its newest link. */
    async revoke(token: string): Promise<boolean> {
        const rec = this.tokens[digest(token)];
        if (!rec) {
            return false;
        }
        await this.revokeFamily(rec.familyId);
        return true;
    }

    async revokeFamily(familyId: string): Promise<void> {
        let changed = false;
        for (const [key, rec] of Object.entries(this.tokens)) {
            if (rec.familyId === familyId) {
                delete this.tokens[key];
                changed = true;
            }
        }
        if (changed) {
            await this.persist();
        }
    }

    /**
     * Drop every token held for a user.
     *
     * Called when an account is deleted or its password is reset. Without this,
     * `deleteSessionsForUser` would be a lie: the browser session goes, and an
     * app holding a refresh token keeps minting access tokens for an account
     * that no longer exists or whose password was just changed under it.
     */
    async revokeForUser(userId: string): Promise<void> {
        let changed = false;
        for (const [key, rec] of Object.entries(this.tokens)) {
            if (rec.userId === userId) {
                delete this.tokens[key];
                changed = true;
            }
        }
        if (changed) {
            await this.persist();
        }
    }

    /** Drop everything issued to one client — what deleting a registration means
     *  for the grants already handed out under it. */
    async revokeForClient(clientId: string): Promise<void> {
        let changed = false;
        for (const [key, rec] of Object.entries(this.tokens)) {
            if (rec.clientId === clientId) {
                delete this.tokens[key];
                changed = true;
            }
        }
        if (changed) {
            await this.persist();
        }
    }

    /**
     * One row per live family for a user — what the Users screen shows as
     * "connected apps", beside the browser sessions it can no longer describe on
     * its own now that a grant outlives the session that authorized it.
     */
    listForUser(userId: string): Array<{ familyId: string; clientId: string; scope: string; issuedAt: number; expiresAt: number }> {
        const byFamily = new Map<string, RefreshRecord>();
        for (const rec of Object.values(this.tokens)) {
            // Tombstones are bookkeeping, not access — a family whose only rows
            // are spent has been revoked or has lapsed.
            if (rec.userId !== userId || rec.usedAt !== undefined) {
                continue;
            }
            // The newest link carries the current expiry; the family's own age
            // is not tracked, since what matters is when access lapses.
            const seen = byFamily.get(rec.familyId);
            if (!seen || rec.issuedAt > seen.issuedAt) {
                byFamily.set(rec.familyId, rec);
            }
        }
        return [...byFamily.entries()]
            .map(([familyId, rec]) => ({ familyId, clientId: rec.clientId, scope: rec.scope, issuedAt: rec.issuedAt, expiresAt: rec.expiresAt }))
            .sort((a, b) => b.issuedAt - a.issuedAt);
    }

    private async append(familyId: string, params: { userId: string; clientId: string; scope: string }): Promise<string> {
        this.dropStaleTombstones();
        const token = mint();
        const now = Date.now();
        this.tokens[digest(token)] = {
            familyId,
            userId: params.userId,
            clientId: params.clientId,
            scope: params.scope,
            issuedAt: now,
            expiresAt: now + REFRESH_TTL_MS,
        };
        await this.persist();
        return token;
    }

    private async pruneExpired(): Promise<void> {
        const now = Date.now();
        let changed = false;
        for (const [key, rec] of Object.entries(this.tokens)) {
            const spentLongAgo = rec.usedAt !== undefined && rec.usedAt + SPENT_TTL_MS < now;
            if (rec.expiresAt < now || spentLongAgo) {
                delete this.tokens[key];
                changed = true;
            }
        }
        if (changed) {
            await this.persist();
        }
    }

    /** In-memory half of {@link pruneExpired}, run as chains grow rather than
     *  only at startup — a device that refreshes for months between restarts
     *  would otherwise accumulate one row per refresh. */
    private dropStaleTombstones(): void {
        const cutoff = Date.now() - SPENT_TTL_MS;
        for (const [key, rec] of Object.entries(this.tokens)) {
            if (rec.usedAt !== undefined && rec.usedAt < cutoff) {
                delete this.tokens[key];
            }
        }
    }

    private async persist(): Promise<void> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await writeFileAtomic(this.file, JSON.stringify(this.tokens, null, 2));
    }
}
