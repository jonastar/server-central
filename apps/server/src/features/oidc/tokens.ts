import { createHash, createPublicKey, createSign, createVerify } from "node:crypto";
import type { Permission, UserInfo } from "@central/shared";
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

/** Scope values are a space-separated list (RFC 6749 §3.3). */
function hasScope(scope: string, wanted: string): boolean {
    return scope.split(/\s+/).filter(Boolean).includes(wanted);
}

/**
 * The `app.*` grants one relying party is allowed to see.
 *
 * Never the `panel.*` half: a relying party has no use for the control plane's
 * internal nodes, and sending them leaks its structure to every app the owner
 * registers. `groupPrefix` narrows further, to a single app's namespace, so
 * Jellyfin isn't told which roles the user holds in Immich. Null keeps the
 * pre-existing behaviour of sending every `app.*` node.
 *
 * The owner is the awkward case. Its permission set is the single node `*`,
 * which filters to nothing and would silently sign the owner into every app
 * with no roles at all — the control plane's most privileged account arriving
 * as the app's least privileged user. Since `app.*` is an open namespace there
 * is nothing to expand `*` against, so the owner receives the union of:
 *
 *   - `knownAppNodes`, every `app.*` node this installation actually uses
 *     (see AuthStore.knownAppPermissions),
 *   - any app nodes listed on the account itself, and
 *   - every role the App **declares** (`declaredRoles`), which is the whole
 *     reason apps declare them: a freshly registered app that nobody holds
 *     grants for yet would otherwise hand the owner an empty list.
 *
 * Where an App declares nothing, the `.admin` leaf is assumed instead — this
 * codebase's naming convention, and a guess rather than knowledge. Declaring
 * roles on the App replaces the guess with a fact, so an app whose admin role
 * is named something else stops needing the node granted by hand.
 */
export function groupsForClient(
    user: UserInfo,
    groupPrefix: string | null,
    knownAppNodes: readonly Permission[] = [],
    declaredRoles: readonly string[] = [],
): Permission[] {
    const node = groupPrefix ? `app.${groupPrefix}` : null;
    const inScope = (p: Permission): boolean =>
        node === null ? p.startsWith("app.") : p === node || p.startsWith(`${node}.`);

    if (!user.isOwner) {
        return user.permissions.filter(inScope);
    }
    const owned = new Set<Permission>([...knownAppNodes, ...user.permissions].filter(inScope));
    if (node) {
        const expanded = declaredRoles.length > 0
            ? declaredRoles.map((role) => `${node}.${role}`)
            : [`${node}.admin`];
        for (const role of expanded) {
            owned.add(role);
        }
    }
    return [...owned].sort();
}

/**
 * Identity claims a given scope earns, shared by the ID token and the userinfo
 * response so the two cannot drift. `sub` is unconditional; everything else is
 * gated, because `groups` was previously emitted whether or not it was asked
 * for and `profile` was advertised while adding nothing.
 *
 * `email_verified` is always true when an address exists: SC has no self-signup,
 * so the address was either asserted by an administrator or accepted from an
 * upstream provider that verified it. See doc/idea_sign_in_methods.md §2.
 */
export function scopedClaims(
    user: UserInfo,
    scope: string,
    groupPrefix: string | null,
    knownAppNodes: readonly Permission[] = [],
    declaredRoles: readonly string[] = [],
): Record<string, unknown> {
    const claims: Record<string, unknown> = { sub: user.id };
    if (hasScope(scope, "profile")) {
        claims.preferred_username = user.username;
    }
    if (hasScope(scope, "email") && user.email) {
        claims.email = user.email;
        claims.email_verified = true;
    }
    if (hasScope(scope, "groups")) {
        // Custom claim (not OIDC-standard) — how grants are exposed for SSO.
        claims.groups = groupsForClient(user, groupPrefix, knownAppNodes, declaredRoles);
    }
    return claims;
}

export function buildIdToken(
    user: UserInfo,
    opts: {
        issuer: string;
        clientId: string;
        nonce: string | null;
        authTime: number;
        scope: string;
        groupPrefix: string | null;
        knownAppNodes?: readonly Permission[];
        declaredRoles?: readonly string[];
    },
    key: SigningKey,
): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
        ...scopedClaims(user, opts.scope, opts.groupPrefix, opts.knownAppNodes ?? [], opts.declaredRoles ?? []),
        iss: opts.issuer,
        aud: opts.clientId,
        exp: now + ID_TOKEN_TTL_S,
        iat: now,
        auth_time: opts.authTime,
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
