import { createHash, createPublicKey, createSign, createVerify } from "node:crypto";
import type { UserInfo } from "@central/shared";
import type { SigningKey } from "./store";

/** ID tokens are exchanged immediately after issuance, so they can afford to be
 *  short-lived. Access tokens are self-contained JWTs with no revocation list,
 *  so their lifetime is the actual exposure window if one leaks — kept short for
 *  the same reason. Neither has a refresh token in v1. */
const ID_TOKEN_TTL_S = 5 * 60;
export const ACCESS_TOKEN_TTL_S = 60 * 60;

function base64url(input: Buffer | string): string {
    return Buffer.from(input).toString("base64url");
}

function signJwt(payload: Record<string, unknown>, key: SigningKey): string {
    const header = { alg: "RS256", typ: "JWT", kid: key.kid };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = createSign("RSA-SHA256").update(signingInput).sign(key.privateKeyPem);
    return `${signingInput}.${base64url(signature)}`;
}

/** Verify a JWT we issued: checks the RS256 signature against our own public key
 *  and rejects expired tokens. Returns the decoded payload, or null if invalid. */
export function verifyJwt(token: string, publicKeyPem: string): Record<string, unknown> | null {
    const parts = token.split(".");
    if (parts.length !== 3) {
        return null;
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    let ok: boolean;
    try {
        ok = createVerify("RSA-SHA256").update(signingInput).verify(publicKeyPem, Buffer.from(encodedSignature, "base64url"));
    } catch {
        return null;
    }
    if (!ok) {
        return null;
    }
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
        return null;
    }
    return payload;
}

/** RFC 7636 S256: base64url(sha256(code_verifier)) must equal the stored challenge. */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
    return base64url(createHash("sha256").update(codeVerifier).digest()) === codeChallenge;
}

export function buildIdToken(
    user: UserInfo,
    opts: { issuer: string; clientId: string; nonce: string | null; authTime: number },
    key: SigningKey,
): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
        iss: opts.issuer,
        sub: user.id,
        aud: opts.clientId,
        exp: now + ID_TOKEN_TTL_S,
        iat: now,
        auth_time: opts.authTime,
        preferred_username: user.username,
        // Custom claim (not OIDC-standard) — how grants are exposed for SSO.
        // Only the `app.*` half: a relying party has no use for the control
        // plane's internal nodes, and sending them leaks its structure to every
        // app the owner registers.
        groups: user.permissions.filter((p) => p.startsWith("app.")),
    };
    if (opts.nonce) {
        payload.nonce = opts.nonce;
    }
    return signJwt(payload, key);
}

export function buildAccessToken(
    user: UserInfo,
    opts: { issuer: string; clientId: string; scope: string },
    key: SigningKey,
): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iss: opts.issuer,
        sub: user.id,
        aud: opts.clientId,
        scope: opts.scope,
        exp: now + ACCESS_TOKEN_TTL_S,
        iat: now,
    };
    return signJwt(payload, key);
}

/** Public signing key as a JWKS document for `/.well-known/jwks.json`. */
export function jwks(key: SigningKey): { keys: Array<Record<string, unknown>> } {
    const jwk = createPublicKey(key.publicKeyPem).export({ format: "jwk" }) as Record<string, unknown>;
    return { keys: [{ ...jwk, kid: key.kid, use: "sig", alg: "RS256" }] };
}
