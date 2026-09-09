import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DeviceCodeStore, MAX_PENDING, MAX_PENDING_PER_IP, USER_CODE_LENGTH, differsEnough, formatUserCode, normalizeUserCode } from "../../src/features/oidc/device";

/**
 * The device grant's in-memory half (RFC 8628).
 *
 * Several of these need time to have passed — a poll interval, a TTL — and
 * waiting five real seconds for a `slow_down` is not a test. `request()` and
 * `findPending()` both hand back the live record, so the tests age it by writing
 * its timestamps directly. That is white-box on purpose: the alternative is a
 * clock seam in production code that exists only for these.
 */
describe("DeviceCodeStore", () => {
    let devices: DeviceCodeStore;

    beforeEach(() => {
        devices = new DeviceCodeStore();
    });

    const req = (over: Partial<{ clientId: string; scope: string; ip: string | null }> = {}) => devices.request({
        clientId: "c1",
        scope: "openid offline_access",
        ip: "10.0.0.5",
        userAgent: "SomeTV/1.0",
        ...over,
    });

    /** Pretend the client last polled long enough ago to be allowed another. */
    const pollable = <T extends { lastPolledAt: number }>(rec: T): T => {
        rec.lastPolledAt = 0;
        return rec;
    };

    test("mints a typable user code and a separate high-entropy device code", () => {
        const rec = req();

        expect(rec.userCode).toHaveLength(USER_CODE_LENGTH);
        expect(formatUserCode(rec.userCode)).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
        // The code a human reads off a screen and the credential the device
        // polls with are different things; conflating them would make the
        // low-entropy one the credential.
        expect(rec.deviceCode).not.toBe(rec.userCode);
        expect(rec.deviceCode.length).toBeGreaterThan(32);
    });

    test("user codes avoid every character a reader could confuse", () => {
        for (let i = 0; i < 200; i++) {
            const store = new DeviceCodeStore();
            // No 0/O, no 1/I/l, and no vowels — so a live code can never spell a
            // word either.
            expect(store.request({ clientId: "c1", scope: "openid", ip: null, userAgent: null }).userCode)
                .toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/);
        }
    });

    test("a code is not approvable until someone approves it", () => {
        const rec = req();
        expect(devices.poll(pollable(rec).deviceCode, "c1")).toEqual({ error: "authorization_pending" });
    });

    test("polling faster than the interval earns a slow_down, not an answer", () => {
        const rec = req();
        // Fresh record: lastPolledAt is creation time, so this poll is early.
        expect(devices.poll(rec.deviceCode, "c1")).toEqual({ error: "slow_down" });
    });

    test("a hammering client stays slowed even once the request is approved", () => {
        const rec = req();
        devices.resolve(rec.userCode, "approved", "u1");
        // The clock is reset by every poll, including the ones that were too
        // early — otherwise a client that ignores the interval is rewarded with
        // the grant the moment it is approved.
        expect(devices.poll(rec.deviceCode, "c1")).toEqual({ error: "slow_down" });
    });

    test("approval hands the grant over exactly once", () => {
        const rec = req();
        expect(devices.resolve(rec.userCode, "approved", "u1")).not.toBeNull();

        const result = devices.poll(pollable(rec).deviceCode, "c1");
        expect(result).toHaveProperty("ok", true);
        expect((result as { record: { userId: string; scope: string } }).record.userId).toBe("u1");
        expect((result as { record: { scope: string } }).record.scope).toBe("openid offline_access");

        // Single-use, like an authorization code.
        expect(devices.poll(rec.deviceCode, "c1")).toEqual({ error: "invalid_grant" });
    });

    test("denial is reported to the device rather than left to time out", () => {
        const rec = req();
        devices.resolve(rec.userCode, "denied", "u1");
        expect(devices.poll(pollable(rec).deviceCode, "c1")).toEqual({ error: "access_denied" });
        // And it is gone, so a second poll cannot re-read the refusal.
        expect(devices.poll(rec.deviceCode, "c1")).toEqual({ error: "invalid_grant" });
    });

    test("a request that outlives its TTL is expired, not pending forever", () => {
        const rec = req();
        rec.expiresAt = Date.now() - 1;
        expect(devices.poll(rec.deviceCode, "c1")).toEqual({ error: "expired_token" });
        expect(devices.findPending(rec.userCode)).toBeNull();
    });

    test("a device code opened by one client cannot be collected by another", () => {
        const rec = req();
        devices.resolve(rec.userCode, "approved", "u1");
        // Both registrations authenticated successfully as themselves at the
        // token endpoint; that is not the same as being the one that asked.
        expect(devices.poll(pollable(rec).deviceCode, "c2")).toEqual({ error: "invalid_grant" });
    });

    test("an answered request cannot be answered again", () => {
        const rec = req();
        devices.resolve(rec.userCode, "approved", "u1");
        expect(devices.findPending(rec.userCode)).toBeNull();
        expect(devices.resolve(rec.userCode, "denied", "u2")).toBeNull();
    });

    // ---- What the caps and the sampling are actually for -----------------------

    test("no two live codes are one typo apart", () => {
        const codes = Array.from({ length: MAX_PENDING }, (_, i) => req({ ip: `10.0.0.${i}` }).userCode);
        for (let i = 0; i < codes.length; i++) {
            for (let j = i + 1; j < codes.length; j++) {
                expect(differsEnough(codes[i], codes[j])).toBe(true);
            }
        }
    });

    test("the active set is capped globally", () => {
        for (let i = 0; i < MAX_PENDING; i++) {
            req({ ip: `10.0.0.${i}` });
        }
        expect(() => req({ ip: "10.9.9.9" })).toThrow(/pending/i);
    });

    test("and per source address, so one flooder cannot consume the whole budget", () => {
        for (let i = 0; i < MAX_PENDING_PER_IP; i++) {
            req({ ip: "10.0.0.5" });
        }
        expect(() => req({ ip: "10.0.0.5" })).toThrow(/this address/i);
        // A different device in a different house is unaffected.
        expect(() => req({ ip: "10.0.0.6" })).not.toThrow();
    });

    test("expiring requests free their slot", () => {
        const first = req({ ip: "10.0.0.5" });
        for (let i = 1; i < MAX_PENDING_PER_IP; i++) {
            req({ ip: "10.0.0.5" });
        }
        first.expiresAt = Date.now() - 1;
        expect(() => req({ ip: "10.0.0.5" })).not.toThrow();
    });
});

describe("user code handling", () => {
    test("differsEnough rejects the two typos a fixed-length code admits", () => {
        // A wrong key.
        expect(differsEnough("BCDFGHJK", "BCDFGHJL")).toBe(false);
        // Two adjacent characters swapped.
        expect(differsEnough("BCDFGHJK", "BCDFGHKJ")).toBe(false);
        // Two unrelated positions differing is far enough: no single slip does
        // that, and demanding more would reject most of the code space.
        expect(differsEnough("BCDFGHJK", "LCDFGHJL")).toBe(true);
        expect(differsEnough("BCDFGHJK", "ZZZZZZZZ")).toBe(true);
    });

    test("a code is the same code however carefully it was typed", () => {
        // Read off a television and typed by a human: the dash is decoration,
        // the case is whatever the keyboard was doing, and the space is a
        // reflex. Refusing three of these teaches people the flow is broken.
        for (const typed of ["BDWD-HQPK", "bdwdhqpk", "BDWD HQPK", " bdwd-HQPK "]) {
            expect(normalizeUserCode(typed)).toBe("BDWDHQPK");
        }
    });

    test("formatUserCode and normalizeUserCode round-trip", () => {
        expect(normalizeUserCode(formatUserCode("BDWDHQPK"))).toBe("BDWDHQPK");
    });
});
