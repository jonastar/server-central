import { randomBytes, randomInt } from "node:crypto";

/**
 * The device authorization grant (RFC 8628) — pairing something with a screen
 * and no usable keyboard.
 *
 * The TV asks for a code, displays it, and polls. A human reads the code off the
 * screen and types it into `/device` in a browser that *does* have a keyboard.
 * The direction matters: the device displays, the human types elsewhere. The
 * reverse is D-pad text entry, which is the thing being avoided.
 *
 * Pending requests live in memory, like authorization codes and unlike refresh
 * tokens. The whole record is worthless five minutes after it is made, and a
 * restart mid-pairing costs one re-pair — which is a button press on the TV, not
 * a lost grant. Refresh tokens persist precisely because losing *those* is the
 * failure this feature exists to prevent; these are the cheap half.
 */

/** RFC 8628 §6.1's base-20 alphabet: no vowels, so no live code can spell a word,
 *  and none of the classic confusable pairs (`0`/`O`, `1`/`I`/`l`) are in it. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;

/** Shorter than the RFC's more permissive suggestion. The TTL bounds the active
 *  set from the other direction to {@link MAX_PENDING}, and five minutes is
 *  longer than anyone spends walking to a laptop. */
const DEVICE_TTL_MS = 5 * 60 * 1000;

/** Seconds a client must wait between polls, reported to it in the response. */
export const POLL_INTERVAL_S = 5;

/** Tolerance on that interval, so ordinary timer jitter doesn't earn a
 *  `slow_down` from a client that is honestly obeying it. */
const POLL_GRACE_MS = 500;

/**
 * How many pending authorizations may exist at once, globally and per source
 * address.
 *
 * This is the real control, and the honest framing of what it is for. It is not
 * anti-guessing: guessing a user code that someone *else's* TV is displaying and
 * approving it just authorizes their TV. The credential where guessing would
 * steal tokens is the device code, and that one is high-entropy random.
 *
 * What the cap defends is typo collision — an attacker opens thousands of cheap
 * unauthenticated requests, a real user mistypes one character of their own
 * code, lands on the attacker's, and approves it. Capping the active set is what
 * makes {@link differsEnough} tractable, and the two are a pair rather than
 * alternatives. At family scale the active set is single digits, so 64 is pure
 * headroom; the per-address share stops one source from consuming all of it and
 * denying service to the real device.
 */
const MAX_PENDING = 64;
const MAX_PENDING_PER_IP = 8;

/** Attempts before generation gives up. With 20^8 codes and at most
 *  {@link MAX_PENDING} live ones, reaching this means something is wrong rather
 *  than unlucky. */
const GENERATE_ATTEMPTS = 100;

export interface DeviceRequestRecord {
    /** High-entropy random, the credential the device actually polls with. */
    deviceCode: string;
    /** Normalized (no separator), as generated. */
    userCode: string;
    clientId: string;
    scope: string;
    /** Request metadata, shown on the approval screen. A TV has no identity to
     *  display, so this is the only evidence a human can weigh — and an
     *  unfamiliar address is the tell in the read-me-the-code-over-the-phone
     *  variant of the attack. */
    ip: string | null;
    userAgent: string | null;
    createdAt: number;
    expiresAt: number;
    status: "pending" | "approved" | "denied";
    /** Set on approval — whose grant the device collects. */
    userId?: string;
    approvedAt?: number;
    lastPolledAt: number;
}

/** A request a human has answered "yes" to — the two optional fields above are
 *  present exactly here, which is what lets the token endpoint use them without
 *  restating the check. */
export interface ApprovedDeviceRequest extends DeviceRequestRecord {
    userId: string;
    approvedAt: number;
}

/** What a poll resolved to. `ok` is terminal: the record is consumed with it. */
export type DevicePollResult =
    | { ok: true; record: ApprovedDeviceRequest }
    | { error: "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "invalid_grant" };

/** Display form, `XXXX-XXXX`. The separator is presentation only — it is never
 *  stored, and {@link normalizeUserCode} strips whatever the human types. */
export function formatUserCode(code: string): string {
    return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * What a human typed, reduced to what was generated.
 *
 * Someone reading `BDWD-HQPK` off a television types it with the dash, without
 * it, in lower case, or with a stray space. All four are the same code, and
 * refusing three of them teaches people the flow is broken rather than that
 * they made a mistake. Characters outside the alphabet are dropped rather than
 * rejected so that the length check below is the single verdict.
 */
export function normalizeUserCode(input: string): string {
    return [...input.toUpperCase()].filter((c) => USER_CODE_ALPHABET.includes(c)).join("");
}

/**
 * Whether two codes are far enough apart that no single slip turns one into the
 * other.
 *
 * Codes are a fixed length, so the typos that can produce *another valid code*
 * are exactly two: hitting the wrong key (differs in one position) and swapping
 * two adjacent characters (differs in two, but adjacently and symmetrically).
 * Dropping or doubling a character changes the length and is caught by the
 * format check instead. Rejecting both classes across the live set makes a
 * mistyped code structurally incapable of landing on someone else's pending
 * request — it can only miss.
 */
export function differsEnough(a: string, b: string): boolean {
    const differing: number[] = [];
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            differing.push(i);
            if (differing.length > 2) {
                return true;
            }
        }
    }
    if (differing.length < 2) {
        return false;
    }
    const [i, j] = differing;
    // An adjacent transposition: two neighbouring positions differ, and each
    // holds the character the other one wants.
    return !(j === i + 1 && a[i] === b[j] && a[j] === b[i]);
}

export class DeviceCodeStore {
    private requests = new Map<string, DeviceRequestRecord>();

    /**
     * Open a pending authorization.
     *
     * Throws when the active set is full — the caller turns that into a
     * `slow_down`, which is the RFC's vocabulary for "you are asking too often,
     * come back later" even though the RFC only defines it at the token
     * endpoint.
     */
    request(params: { clientId: string; scope: string; ip: string | null; userAgent: string | null }): DeviceRequestRecord {
        this.prune();
        const pending = [...this.requests.values()].filter((r) => r.status === "pending");
        if (pending.length >= MAX_PENDING) {
            throw new DeviceCapError("Too many device authorizations are pending. Try again in a few minutes.");
        }
        if (params.ip !== null && pending.filter((r) => r.ip === params.ip).length >= MAX_PENDING_PER_IP) {
            throw new DeviceCapError("Too many device authorizations are pending from this address.");
        }
        const now = Date.now();
        const rec: DeviceRequestRecord = {
            deviceCode: randomBytes(32).toString("base64url"),
            userCode: this.generateUserCode(pending),
            clientId: params.clientId,
            scope: params.scope,
            ip: params.ip,
            userAgent: params.userAgent,
            createdAt: now,
            expiresAt: now + DEVICE_TTL_MS,
            status: "pending",
            // Counted from creation, so the first poll is held to the interval
            // like every later one.
            lastPolledAt: now,
        };
        this.requests.set(rec.deviceCode, rec);
        return rec;
    }

    /** Rejection sampling against the live set — see {@link differsEnough}. */
    private generateUserCode(pending: DeviceRequestRecord[]): string {
        for (let attempt = 0; attempt < GENERATE_ATTEMPTS; attempt++) {
            let code = "";
            for (let i = 0; i < USER_CODE_LENGTH; i++) {
                code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
            }
            if (pending.every((r) => differsEnough(code, r.userCode))) {
                return code;
            }
        }
        throw new DeviceCapError("Could not allocate a device code. Try again in a few minutes.");
    }

    /** Resolve what a human typed, for the approval screen. Pending only: an
     *  already-answered request is not a thing to answer again. */
    findPending(userCode: string): DeviceRequestRecord | null {
        this.prune();
        const normalized = normalizeUserCode(userCode);
        if (normalized.length !== USER_CODE_LENGTH) {
            return null;
        }
        for (const rec of this.requests.values()) {
            if (rec.userCode === normalized && rec.status === "pending") {
                return rec;
            }
        }
        return null;
    }

    /** Answer a pending request. The device learns the outcome on its next poll. */
    resolve(userCode: string, outcome: "approved" | "denied", userId: string): DeviceRequestRecord | null {
        const rec = this.findPending(userCode);
        if (!rec) {
            return null;
        }
        rec.status = outcome;
        rec.userId = userId;
        rec.approvedAt = Date.now();
        return rec;
    }

    /**
     * One poll from the device.
     *
     * `clientId` is checked here rather than only at the endpoint because the
     * device code is bearer-shaped: a registration that authenticated
     * successfully as itself must still not be able to collect a grant opened
     * by a different one.
     */
    poll(deviceCode: string, clientId: string): DevicePollResult {
        // Deliberately does not prune first. Pruning would delete this very
        // record a moment before the expiry check below could name it, and the
        // device would be told `invalid_grant` — "that was never a code" —
        // rather than `expired_token`, which is the one answer that tells it to
        // start a fresh pairing. Trimming the active set is `request`'s job,
        // where the size actually matters.
        const rec = this.requests.get(deviceCode);
        if (!rec || rec.clientId !== clientId) {
            return { error: "invalid_grant" };
        }
        if (rec.expiresAt < Date.now()) {
            this.requests.delete(deviceCode);
            return { error: "expired_token" };
        }
        // Recorded before the status checks so that a client hammering a pending
        // request stays slowed rather than being let through the moment it is
        // approved.
        const polledAt = rec.lastPolledAt;
        rec.lastPolledAt = Date.now();
        if (rec.status === "denied") {
            this.requests.delete(deviceCode);
            return { error: "access_denied" };
        }
        if (Date.now() - polledAt < POLL_INTERVAL_S * 1000 - POLL_GRACE_MS) {
            return { error: "slow_down" };
        }
        if (rec.status === "pending") {
            return { error: "authorization_pending" };
        }
        // Only "approved" is left, and reading the two fields back is what
        // narrows the record to ApprovedDeviceRequest without asserting it.
        if (rec.userId === undefined || rec.approvedAt === undefined) {
            return { error: "invalid_grant" };
        }
        // Single-use, like an authorization code: the grant is collected once.
        this.requests.delete(deviceCode);
        return { ok: true, record: { ...rec, userId: rec.userId, approvedAt: rec.approvedAt } };
    }

    /** Test/diagnostic view of the live set. */
    get size(): number {
        this.prune();
        return this.requests.size;
    }

    private prune(): void {
        const now = Date.now();
        for (const [key, rec] of this.requests) {
            if (rec.expiresAt < now) {
                this.requests.delete(key);
            }
        }
    }
}

/** The active set is full. Distinguished from a malformed request so the
 *  endpoint can answer 429 rather than 400. */
export class DeviceCapError extends Error {}

export const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export { DEVICE_TTL_MS, MAX_PENDING, MAX_PENDING_PER_IP, USER_CODE_LENGTH };
