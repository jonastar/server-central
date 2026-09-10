import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { UserInfo } from "@central/shared";
import { AuthStore } from "../../src/auth";
import { RoleStore } from "../../src/roles";

/** AuthStore resolves role ids to permissions, so tests need a seeded store. */
async function makeRoles(dir: string): Promise<RoleStore> {
    const roles = new RoleStore(dir);
    await roles.init();
    return roles;
}
import { OidcStore } from "../../src/features/oidc/store";
import { buildAccessToken, buildIdToken, groupsForClient, jwks, scopedClaims, verifyJwt, verifyPkce } from "../../src/features/oidc/tokens";
import { discoveryDocument } from "../../src/features/oidc/discovery";

const ISSUER = "https://central.example.com";

/** A non-owner holding both `panel.*` and `app.*` grants, for claim-filtering
 *  tests. A factory rather than a constant so a test can spread over it safely.
 *  The owner resolves groups by a different route — see its own test. */
function withGrants(): UserInfo {
    return {
        id: "u1",
        username: "alice",
        isOwner: false,
        roleIds: [],
        createdAt: 0,
        systemUser: null,
        email: null,
        permissions: ["panel.files.write", "app.immich.admin", "app.jellyfin.user"],
    };
}

/** A PKCE verifier/challenge pair (S256), the shape a real relying party sends. */
function pkcePair() {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}

describe("OIDC provider", () => {
    let dir: string;
    let auth: AuthStore;
    let oidc: OidcStore;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-oidc-test-"));
        auth = new AuthStore(await makeRoles(dir), dir);
        await auth.init();
        oidc = new OidcStore(dir);
        await oidc.init();
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    test("createClient / verifyClientSecret", async () => {
        const { client, clientSecret } = await oidc.createClient("My App", ["https://app.example.com/callback"]);
        expect(await oidc.verifyClientSecret(client.id, clientSecret)).toMatchObject({ id: client.id });
        expect(await oidc.verifyClientSecret(client.id, "wrong-secret")).toBeNull();
        expect(await oidc.verifyClientSecret("unknown-client", clientSecret)).toBeNull();
    });

    test("updateClient fixes a redirect URI without invalidating the credential", async () => {
        // The case this exists for: registered against a placeholder, then
        // corrected once the app is actually deployed.
        const { client, clientSecret } = await oidc.createClient("Jellyfin", ["https://example.com"]);

        await oidc.updateClient({ ...client, redirectUris: ["https://jelly.example.com/sso/OID/redirect/sc"] });

        const after = oidc.getClient(client.id);
        expect(after?.redirectUris).toEqual(["https://jelly.example.com/sso/OID/redirect/sc"]);
        // The point of editing rather than re-registering: the app does not have
        // to be reconfigured to correct a typo.
        expect(after?.id).toBe(client.id);
        expect(after?.createdAt).toBe(client.createdAt);
        expect(await oidc.verifyClientSecret(client.id, clientSecret)).not.toBeNull();
    });

    test("updateClient can relink and unlink the App that scopes the groups claim", async () => {
        const { client } = await oidc.createClient("Jellyfin", ["https://jelly.example.com/cb"], "app-1");
        expect(oidc.getClient(client.id)?.appId).toBe("app-1");

        await oidc.updateClient({ ...client, appId: "app-2" });
        expect(oidc.getClient(client.id)?.appId).toBe("app-2");

        // Clearing it has to be expressible, or a client linked to the wrong App
        // could only be unlinked by deleting it.
        await oidc.updateClient({ ...client, appId: null });
        expect(oidc.getClient(client.id)?.appId).toBeNull();
    });

    test("updateClient validates the same way createClient does", async () => {
        const { client } = await oidc.createClient("My App", ["https://app.example.com/callback"]);
        await expect(oidc.updateClient({ ...client, name: "  " })).rejects.toThrow(/name/i);
        await expect(oidc.updateClient({ ...client, redirectUris: [] })).rejects.toThrow(/redirect uri/i);
        await expect(oidc.updateClient({ ...client, redirectUris: ["not a url"] })).rejects.toThrow(/invalid redirect uri/i);
        // A rejected edit leaves the record alone.
        expect(oidc.getClient(client.id)?.redirectUris).toEqual(["https://app.example.com/callback"]);
    });

    test("updateClient refuses an unknown client rather than creating one", async () => {
        await expect(oidc.updateClient({
            id: "nope", name: "X", redirectUris: ["https://x.example.com"],
            createdAt: 0, appId: null, groupPrefix: null,
        })).rejects.toThrow(/unknown client/i);
        expect(oidc.listClients()).toHaveLength(0);
    });

    test("an edited redirect URI is what the authorize request is matched against", async () => {
        const { client } = await oidc.createClient("Jellyfin", ["https://example.com"]);
        await oidc.updateClient({ ...client, redirectUris: ["https://jelly.example.com/cb"] });

        const params = {
            clientId: client.id, scope: "openid", state: "s",
            codeChallenge: "c", codeChallengeMethod: "S256" as const,
        };
        expect(() => oidc.validateRequest({ ...params, redirectUri: "https://example.com" })).toThrow(/redirect_uri/);
        expect(oidc.validateRequest({ ...params, redirectUri: "https://jelly.example.com/cb" }).id).toBe(client.id);
    });

    test("createClient rejects missing name/redirect URIs", async () => {
        await expect(oidc.createClient("", ["https://app.example.com"])).rejects.toThrow(/name/i);
        await expect(oidc.createClient("My App", [])).rejects.toThrow(/redirect uri/i);
        await expect(oidc.createClient("My App", ["not a url"])).rejects.toThrow(/invalid redirect uri/i);
    });

    test("validateRequest enforces client + redirect_uri + PKCE", async () => {
        const { client } = await oidc.createClient("My App", ["https://app.example.com/callback"]);
        const { challenge } = pkcePair();
        const base = { clientId: client.id, redirectUri: "https://app.example.com/callback", scope: "openid", state: "s" };

        expect(oidc.validateRequest({ ...base, codeChallenge: challenge, codeChallengeMethod: "S256" })).toMatchObject({ id: client.id });

        expect(() => oidc.validateRequest({ ...base, clientId: "unknown", codeChallenge: challenge, codeChallengeMethod: "S256" }))
            .toThrow(/unknown client/i);
        expect(() => oidc.validateRequest({ ...base, redirectUri: "https://evil.example.com", codeChallenge: challenge, codeChallengeMethod: "S256" }))
            .toThrow(/redirect_uri/i);
        expect(() => oidc.validateRequest({ ...base, codeChallenge: "", codeChallengeMethod: "S256" }))
            .toThrow(/pkce/i);
    });

    test("authorization codes are single-use", async () => {
        const { client } = await oidc.createClient("My App", ["https://app.example.com/callback"]);
        const { challenge } = pkcePair();
        const code = oidc.issueCode({
            userId: "u1",
            clientId: client.id,
            redirectUri: "https://app.example.com/callback",
            scope: "openid",
            codeChallenge: challenge,
            nonce: null,
        });

        expect(oidc.consumeCode(code)).toMatchObject({ userId: "u1", clientId: client.id });
        expect(oidc.consumeCode(code)).toBeNull(); // already consumed
        expect(oidc.consumeCode("never-issued")).toBeNull();
    });

    test("verifyPkce matches S256(code_verifier) against the stored challenge", () => {
        const { verifier, challenge } = pkcePair();
        expect(verifyPkce(verifier, challenge)).toBe(true);
        expect(verifyPkce("wrong-verifier", challenge)).toBe(false);
    });

    test("full authorization_code + PKCE round trip mints tokens that verify against this server's own key", async () => {
        const { user } = await auth.setupOwner("alice", "supersecret");
        const { client } = await oidc.createClient("My App", ["https://app.example.com/callback"]);
        const { verifier, challenge } = pkcePair();

        // 1. Front-channel: SPA resolves + confirms the request, minting a code.
        const resolved = oidc.validateRequest({
            clientId: client.id,
            redirectUri: "https://app.example.com/callback",
            scope: "openid profile groups",
            state: "xyz",
            codeChallenge: challenge,
            codeChallengeMethod: "S256",
        });
        const code = oidc.issueCode({
            userId: user.id,
            clientId: resolved.id,
            redirectUri: "https://app.example.com/callback",
            scope: "openid profile groups",
            codeChallenge: challenge,
            nonce: "n-123",
        });

        // 2. Token endpoint: exchange the code + verifier for tokens.
        const grant = oidc.consumeCode(code)!;
        expect(verifyPkce(verifier, grant.codeChallenge)).toBe(true);
        const key = oidc.key;
        const idToken = buildIdToken(user, { issuer: ISSUER, clientId: client.id, nonce: grant.nonce, authTime: Math.floor(grant.issuedAt / 1000), scope: grant.scope, groupPrefix: client.groupPrefix }, key);
        const accessToken = buildAccessToken(user, { issuer: ISSUER, clientId: client.id, scope: grant.scope }, key);

        // 3. Relying party verifies the ID token against the published JWKS key.
        const jwk = jwks(key).keys[0];
        expect(jwk.kid).toBe(key.kid);
        expect(jwk.alg).toBe("RS256");

        const idPayload = verifyJwt(idToken, key.publicKeyPem);
        expect(idPayload).toMatchObject({
            iss: ISSUER,
            sub: user.id,
            aud: client.id,
            nonce: "n-123",
            preferred_username: "alice",
            // Only the `app.*` half of the caller's grants — a relying party has
            // no use for the control plane's own nodes, and sending them would
            // leak its structure to every app the owner registers. Empty here
            // because this client declares no groupPrefix and the installation
            // grants no app nodes at all, so the owner's `*` has nothing to
            // expand against; see the owner test above for the populated case.
            groups: [],
        });

        const accessPayload = verifyJwt(accessToken, key.publicKeyPem);
        expect(accessPayload).toMatchObject({ iss: ISSUER, sub: user.id, aud: client.id, scope: "openid profile groups" });
    });

    test("app grants reach the groups claim; panel grants never do", async () => {
        const payload = verifyJwt(
            buildIdToken(withGrants(), { issuer: ISSUER, clientId: "c1", nonce: null, authTime: 0, scope: "openid groups", groupPrefix: null }, oidc.key),
            oidc.key.publicKeyPem,
        );
        expect(payload?.groups).toEqual(["app.immich.admin", "app.jellyfin.user"]);
    });

    test("groupPrefix narrows the groups claim to one app's namespace", () => {
        const scoped = scopedClaims(withGrants(), "openid groups", "immich");
        expect(scoped.groups).toEqual(["app.immich.admin"]);
        // Unset stays the pre-existing behaviour, so clients registered before
        // the field existed keep receiving what they always did.
        expect(scopedClaims(withGrants(), "openid groups", null).groups).toEqual(["app.immich.admin", "app.jellyfin.user"]);
        // A prefix is a whole namespace segment, not a string prefix: "immich"
        // must not also match a hypothetical "app.immichfoo.*".
        expect(groupsForClient({ ...withGrants(), permissions: ["app.immichfoo.admin"] }, "immich")).toEqual([]);
    });

    test("the owner's wildcard expands to the app roles this installation uses", async () => {
        const { user: owner } = await auth.setupOwner("alice", "supersecret");
        const bob = await auth.addUser("bob", "supersecret", []);
        await auth.setPermissions(bob.id, ["app.immich.user", "app.jellyfin.user"]);

        const ownerInfo = auth.getUserById(owner.id)!;
        // The reason this needs handling at all: the owner's whole permission
        // set is one node no relying party can interpret, and filtering it for
        // `app.*` yields nothing — signing the control plane's most privileged
        // account into every app as its least privileged user.
        expect(ownerInfo.permissions).toEqual(["*"]);

        const known = auth.knownAppPermissions();
        expect(known).toEqual(["app.immich.user", "app.jellyfin.user"]);
        expect(groupsForClient(ownerInfo, null, known)).toEqual(["app.immich.user", "app.jellyfin.user"]);

        // Prefixed: that app's nodes, plus the conventional `.admin` leaf, so a
        // freshly registered app nobody holds grants for yet still admits the
        // owner as an admin rather than as nobody.
        expect(groupsForClient(ownerInfo, "immich", known)).toEqual(["app.immich.admin", "app.immich.user"]);
        expect(groupsForClient(ownerInfo, "plex", [])).toEqual(["app.plex.admin"]);

        // Non-owners are untouched: they get exactly what they hold.
        expect(groupsForClient(auth.getUserById(bob.id)!, "immich", known)).toEqual(["app.immich.user"]);
    });

    test("declared roles replace the guessed .admin leaf for the owner", async () => {
        const { user } = await auth.setupOwner("alice", "supersecret");
        const owner = auth.getUserById(user.id)!;

        // With nothing declared, the owner gets the naming convention — a guess,
        // and wrong for an app whose admin role is called something else.
        expect(groupsForClient(owner, "plex", [], [])).toEqual(["app.plex.admin"]);

        // Declaring them makes it a fact, and covers every role rather than just
        // the one the convention happens to name.
        expect(groupsForClient(owner, "plex", [], ["viewer", "owner"]))
            .toEqual(["app.plex.owner", "app.plex.viewer"]);

        // Non-owners are unaffected either way — declaring a role does not grant it.
        const bob = await auth.addUser("bob", "supersecret", []);
        expect(groupsForClient(auth.getUserById(bob.id)!, "plex", [], ["viewer", "owner"])).toEqual([]);
    });

    test("claims are gated on the requested scope", () => {
        const user = { ...withGrants(), email: "alice@example.com" };
        // `openid` alone earns nothing but the subject. Previously `groups` was
        // emitted unconditionally and `profile` was advertised while adding
        // nothing, so a strict relying party got claims it never asked for.
        expect(scopedClaims(user, "openid", null)).toEqual({ sub: "u1" });

        expect(scopedClaims(user, "openid profile", null)).toEqual({ sub: "u1", preferred_username: "alice" });

        const withEmail = scopedClaims(user, "openid email", null);
        expect(withEmail).toEqual({ sub: "u1", email: "alice@example.com", email_verified: true });

        // No address on the account means no claim, rather than a null one that
        // a relying party would key an account on.
        expect(scopedClaims(withGrants(), "openid email", null)).toEqual({ sub: "u1" });
    });

    test("verifyJwt rejects a tampered signature and a token signed by a different key", async () => {
        const { user } = await auth.setupOwner("alice", "supersecret");
        const key = oidc.key;
        const token = buildIdToken(user, { issuer: ISSUER, clientId: "c1", nonce: null, authTime: 0, scope: "openid profile", groupPrefix: null }, key);

        const [h, p, sig] = token.split(".");
        const flipped = sig[0] === "A" ? "B" : "A";
        expect(verifyJwt(`${h}.${p}.${flipped}${sig.slice(1)}`, key.publicKeyPem)).toBeNull();

        const otherOidc = new OidcStore(await fs.mkdtemp(path.join(os.tmpdir(), "sc-oidc-test-other-")));
        await otherOidc.init();
        expect(verifyJwt(token, otherOidc.key.publicKeyPem)).toBeNull();
    });

    test("discoveryDocument advertises the configured issuer and PKCE-only, code-only support", () => {
        const doc = discoveryDocument(ISSUER);
        expect(doc.issuer).toBe(ISSUER);
        expect(doc.authorization_endpoint).toBe(`${ISSUER}/oidc/authorize`);
        expect(doc.token_endpoint).toBe(`${ISSUER}/oidc/token`);
        expect(doc.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
        expect(doc.response_types_supported).toEqual(["code"]);
        expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    });

    test("signing key is generated once and persists across restarts", async () => {
        const first = oidc.key;
        const second = new OidcStore(dir);
        await second.init();
        expect(second.key.kid).toBe(first.kid);
        expect(second.key.privateKeyPem).toBe(first.privateKeyPem);
    });
});
