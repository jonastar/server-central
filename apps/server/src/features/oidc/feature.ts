import type { OidcAuthorizeParams, OidcClient, UserInfo } from "@central/shared";
import type { AuthStore, AuthContext } from "../../auth";
import { readConfig } from "../../config";
import type { HttpRoute } from "../../feature";
import { defineFeature } from "../../feature";
import type { AppStore } from "../apps/store";
import type { RefreshTokenStore } from "./refresh";
import type { OidcStore } from "./store";
import { discoveryDocument } from "./discovery";
import type { DeviceCodeStore } from "./device";
import { DEVICE_CODE_GRANT, DeviceCapError, POLL_INTERVAL_S, formatUserCode } from "./device";
import { ACCESS_TOKEN_TTL_S, buildAccessToken, buildIdToken, groupsForClient, jwks, scopedClaims, verifyJwt, verifyPkce } from "./tokens";

// An OIDC client is a relying-party registration (id/secret + redirect URIs) for
// Central's built-in OIDC provider — unrelated to the App entity (compose stacks
// on a host) the apps feature owns.

export const createOidcFeature = (oidc: OidcStore, auth: AuthStore, apps: AppStore, refresh: RefreshTokenStore, devices: DeviceCodeStore) => defineFeature({
    id: "oidc",
    name: "OIDC provider",
    description: "Central's built-in OpenID Connect provider and its client registrations.",
    experimental: false,
    dependsOn: ["auth", "apps"],
    
    async init() {
        await oidc.init();
        await refresh.init();
    },
    ops: {
        // ---- Client registrations (owner-only admin) ---------------------------

        async listClients(_data, ctx?: AuthContext) {
            return oidc.listClients();
        },

        async createClient(data, ctx?: AuthContext) {
            const config = await readConfig();
            if (!config.primaryUrl) {
                throw new Error("Set a Primary URL in Settings before registering OIDC clients");
            }
            return oidc.createClient(data.name, data.redirectUris, data.appId ?? null);
        },

        async deleteClient(data, ctx?: AuthContext) {
            await oidc.deleteClient(data.clientId);
            // Grants already handed out under a registration outlive it
            // otherwise: the client can no longer authenticate at the token
            // endpoint, but leaving live rows behind would keep them listed as
            // connected apps forever.
            await refresh.revokeForClient(data.clientId);
        },

        async regenerateSecret(data) {
            return { clientSecret: await oidc.regenerateSecret(data.clientId) };
        },

        // ---- Grants held on a user's behalf (Users screen) ---------------------

        async listGrants(data) {
            const clients = oidc.listClients();
            return refresh.listForUser(data.userId).map((grant) => ({
                ...grant,
                // A registration can be deleted while its grants are still
                // listed; showing the raw id would be useless to a reader.
                clientName: clients.find((c) => c.id === grant.clientId)?.name ?? "(deleted client)",
            }));
        },

        async revokeGrant(data) {
            await refresh.revokeFamily(data.familyId);
        },

        // ---- Front-channel (authenticated user) --------------------------------
        //
        // Driven by the SPA's /oidc/authorize route: it resolves the request to
        // show "Continue as X to <app>?", then mints the code on confirm. The
        // actual code-for-token exchange is raw HTTP at POST /oidc/token (see
        // index.ts), since that leg is called by the relying party's backend, not
        // the browser.

        async getAuthorizeRequest(data) {
            const app = oidc.validateRequest(data);
            return { appName: app.name, redirectUri: data.redirectUri };
        },

        async completeAuthorize(data, ctx?: AuthContext) {
            if (!ctx?.user) {
                throw new Error("Not authenticated");
            }
            const client = oidc.validateRequest(data);
            assertMayAccess(ctx.user, client, data.scope, apps, auth);
            const code = oidc.issueCode({
                userId: ctx.user.id,
                clientId: client.id,
                redirectUri: data.redirectUri,
                scope: data.scope,
                codeChallenge: data.codeChallenge,
                nonce: data.nonce ?? null,
            });
            const url = new URL(data.redirectUri);
            url.searchParams.set("code", code);
            url.searchParams.set("state", data.state);
            return { redirectUrl: url.toString() };
        },

        // ---- Device grant, browser half (RFC 8628 §3.3) ------------------------
        //
        // The device polls `/oidc/token` for an answer; these three are what
        // produces one. Reached from the SPA's `/device` route, where a human
        // types the code their television is displaying.

        async getDeviceRequest(data) {
            const rec = devices.findPending(data.userCode);
            if (!rec) {
                // Expired, already answered, and never existed are one answer on
                // purpose. Distinguishing them would tell an unauthenticated-
                // enough caller which codes are live, and none of the three
                // changes what the person in front of the screen should do.
                return null;
            }
            return {
                // What matched, not what was typed — the screen can then show
                // the canonical form and a dash-less entry is visibly accepted.
                userCode: formatUserCode(rec.userCode),
                appName: oidc.getClient(rec.clientId)?.name ?? "(deleted client)",
                scope: rec.scope,
                ip: rec.ip,
                userAgent: rec.userAgent,
                requestedAt: rec.createdAt,
                expiresAt: rec.expiresAt,
            };
        },

        async approveDevice(data, ctx?: AuthContext) {
            if (!ctx?.user) {
                throw new Error("Not authenticated");
            }
            const rec = devices.findPending(data.userCode);
            if (!rec) {
                throw new Error("That code is no longer valid. Check the code on your device, or start again there.");
            }
            const client = oidc.getClient(rec.clientId);
            if (!client) {
                throw new Error("The app that requested this code is no longer registered.");
            }
            // The same gate the browser flow runs. Without it the device grant
            // would be the way around an App's `requireRole`: same account, same
            // app, no check — which is what "one credential type, two ways to
            // mint" has to mean if it is to mean anything.
            assertMayAccess(ctx.user, client, rec.scope, apps, auth);
            devices.resolve(data.userCode, "approved", ctx.user.id);
        },

        async denyDevice(data, ctx?: AuthContext) {
            if (!ctx?.user) {
                throw new Error("Not authenticated");
            }
            // No error when nothing matches: "that code is gone" and "I have now
            // refused it" are the same outcome to a person who came here to say
            // no, and the device is left to time out either way.
            devices.resolve(data.userCode, "denied", ctx.user.id);
        },
    },
    httpRoutes: () => oidcHttpRoutes(oidc, auth, apps, refresh, devices),
});

// ---- Raw HTTP endpoints ---------------------------------------------------------
//
// The parts of OIDC that can't be RPC operations. `/.well-known/*` are public GETs
// at paths fixed by spec; `/oidc/token` is called by the relying party's *backend*,
// so it's `application/x-www-form-urlencoded` and authenticates with the client's
// own credential (client_secret_post or HTTP Basic) rather than a session bearer
// token. `GET /oidc/authorize` needs no entry — it's a plain browser navigation
// that falls through to the SPA shell, and the React app recognizes the path.

/**
 * The two conditions that must hold before a user is granted anything for a
 * client, in either front channel.
 *
 * Both were written inline in `completeAuthorize` when the browser code flow was
 * the only way to reach them. The device grant is the second way, and leaving
 * them inline would have made it the way around them — so they moved here,
 * where there is one copy for both callers to run.
 *
 * Throws a message written for the person reading it on a screen.
 */
export function assertMayAccess(user: UserInfo, client: OidcClient, scope: string, apps: AppStore, auth: AuthStore): void {
    // An RP that asks for `email` almost certainly keys its accounts on it
    // (Immich does). Silently dropping the claim lets it create a broken account
    // that then has to be reconciled by hand, so fail here instead — while the
    // user is still looking at a screen.
    if (scope.split(/\s+/).includes("email") && !user.email) {
        throw new Error(`${client.name} requires an email address, and your account has none. Ask an administrator to set one.`);
    }
    // Access gate, when the linked App asks for one. Without it an `app.*` grant
    // only *describes* access — anyone who can sign into the control plane could
    // complete this flow and let the app decide what an unknown user means,
    // which is usually "create an account".
    const linked = client.appId ? apps.get(client.appId) : null;
    if (linked?.requireRole) {
        // The same predicate that decides the `groups` claim, so the owner
        // passes on its expanded roles rather than on a special case, and a user
        // passes exactly when the app would have been told about at least one of
        // their roles.
        if (groupsForClient(user, linked.slug, auth.knownAppPermissions(), linked.roles).length === 0) {
            throw new Error(`Your account has no access to ${linked.name}. Ask an administrator to grant you a role.`);
        }
    }
}

function clientCredentials(req: Request, body: URLSearchParams): { clientId: string; clientSecret: string } | null {
    const basic = req.headers.get("Authorization");
    if (basic?.startsWith("Basic ")) {
        const decoded = Buffer.from(basic.slice(6), "base64").toString("utf8");
        const sep = decoded.indexOf(":");
        if (sep !== -1) {
            return { clientId: decoded.slice(0, sep), clientSecret: decoded.slice(sep + 1) };
        }
    }
    const clientId = body.get("client_id");
    const clientSecret = body.get("client_secret");
    return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function bearerToken(req: Request): string | null {
    const header = req.headers.get("Authorization");
    if (!header) {
        return null;
    }
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1] : null;
}

/** The `app.<slug>.` namespace a client's groups claim is limited to.
 *
 *  An App reference wins over the legacy direct prefix: the App's slug is the
 *  one definition of that name, and `groupPrefix` only survives for clients
 *  registered before Apps existed. Both absent means "every `app.*` node",
 *  which is the behaviour clients had before either field. */
export function effectiveGroupPrefix(client: OidcClient, apps: AppStore): string | null {
    return apps.slugFor(client.appId) ?? client.groupPrefix ?? null;
}

/** The role names the linked App declares, which is what the owner's `*`
 *  expands to instead of the guessed `.admin` leaf. Empty for an unlinked
 *  client, or one whose App declares none. */
export function declaredRolesFor(client: OidcClient, apps: AppStore): string[] {
    return (client.appId ? apps.get(client.appId)?.roles : null) ?? [];
}

export function oidcHttpRoutes(oidc: OidcStore, auth: AuthStore, apps: AppStore, refresh: RefreshTokenStore, devices: DeviceCodeStore): HttpRoute[] {
    async function discovery(_req: Request, cors: Record<string, string>, which: "config" | "jwks"): Promise<Response> {
        const config = await readConfig();
        if (!config.primaryUrl) {
            return Response.json({ error: "Primary URL is not configured" }, { status: 404, headers: cors });
        }
        const body = which === "jwks" ? jwks(oidc.key) : discoveryDocument(config.primaryUrl);
        return Response.json(body, { headers: cors });
    }

    /** Scope values that earn a refresh token (OIDC Core 1.0 §11). */
    function hasOfflineAccess(scope: string): boolean {
        return scope.split(/\s+/).filter(Boolean).includes("offline_access");
    }

    /** The half of a token response that both grants produce identically. */
    function tokenResponse(user: UserInfo, client: OidcClient, scope: string, issuer: string) {
        return {
            access_token: buildAccessToken(user, { issuer, clientId: client.id, scope }, oidc.key),
            token_type: "Bearer",
            expires_in: ACCESS_TOKEN_TTL_S,
            scope,
        };
    }

    /**
     * `grant_type=refresh_token`. Deliberately does **not** mint a new ID token:
     * the client already established who the user is, and re-asserting identity
     * without a fresh authentication would misreport `auth_time`.
     */
    async function refreshGrant(body: URLSearchParams, req: Request, cors: Record<string, string>): Promise<Response> {
        const presented = body.get("refresh_token");
        const creds = clientCredentials(req, body);
        if (!presented || !creds) {
            return Response.json({ error: "invalid_request" }, { status: 400, headers: cors });
        }
        const client = await oidc.verifyClientSecret(creds.clientId, creds.clientSecret);
        if (!client) {
            return Response.json({ error: "invalid_client" }, { status: 401, headers: cors });
        }
        const result = await refresh.rotate(presented);
        if (result === null) {
            return Response.json({ error: "invalid_grant" }, { status: 400, headers: cors });
        }
        if ("reused" in result) {
            return Response.json({
                error: "invalid_grant",
                error_description: "Refresh token was already used; all tokens in this chain have been revoked.",
            }, { status: 400, headers: cors });
        }
        // A token minted for one client must not be redeemable by another, even
        // though both authenticated successfully as themselves.
        if (result.grant.clientId !== client.id) {
            await refresh.revokeFamily(result.grant.familyId);
            return Response.json({ error: "invalid_grant" }, { status: 400, headers: cors });
        }
        const user = auth.getUserById(result.grant.userId);
        if (!user) {
            await refresh.revokeFamily(result.grant.familyId);
            return Response.json({ error: "invalid_grant", error_description: "User no longer exists" }, { status: 400, headers: cors });
        }
        const config = await readConfig();
        if (!config.primaryUrl) {
            return Response.json({ error: "server_error", error_description: "Primary URL is not configured" }, { status: 500, headers: cors });
        }
        return Response.json({
            ...tokenResponse(user, client, result.grant.scope, config.primaryUrl),
            refresh_token: result.next,
        }, { headers: cors });
    }

    /**
     * `grant_type=urn:ietf:params:oauth:grant-type:device_code` — the device
     * collecting the answer to what a human approved in a browser.
     *
     * Unlike the refresh grant this *does* mint an ID token: the approval was a
     * fresh authentication by a present human, so `auth_time` has something true
     * to say. There is no `nonce` — the device never ran a browser redirect, so
     * there was no round trip to bind one to.
     */
    async function deviceGrant(body: URLSearchParams, req: Request, cors: Record<string, string>): Promise<Response> {
        const deviceCode = body.get("device_code");
        const creds = clientCredentials(req, body);
        if (!deviceCode || !creds) {
            return Response.json({ error: "invalid_request" }, { status: 400, headers: cors });
        }
        const client = await oidc.verifyClientSecret(creds.clientId, creds.clientSecret);
        if (!client) {
            return Response.json({ error: "invalid_client" }, { status: 401, headers: cors });
        }
        const result = devices.poll(deviceCode, client.id);
        if ("error" in result) {
            // Every one of these is a 400 with an OAuth error code, including
            // the two that are not failures — `authorization_pending` and
            // `slow_down` are how RFC 8628 §3.5 says "keep waiting".
            return Response.json({ error: result.error }, { status: 400, headers: cors });
        }
        const user = auth.getUserById(result.record.userId);
        if (!user) {
            return Response.json({ error: "invalid_grant", error_description: "User no longer exists" }, { status: 400, headers: cors });
        }
        const config = await readConfig();
        if (!config.primaryUrl) {
            return Response.json({ error: "server_error", error_description: "Primary URL is not configured" }, { status: 500, headers: cors });
        }
        const scope = result.record.scope;
        return Response.json({
            ...tokenResponse(user, client, scope, config.primaryUrl),
            id_token: buildIdToken(user, {
                issuer: config.primaryUrl,
                clientId: client.id,
                nonce: null,
                authTime: Math.floor(result.record.approvedAt / 1000),
                scope,
                groupPrefix: effectiveGroupPrefix(client, apps),
                knownAppNodes: auth.knownAppPermissions(),
                declaredRoles: declaredRolesFor(client, apps),
            }, oidc.key),
            // The whole point of pairing a television: it must not have to come
            // back through a flow that needs a keyboard.
            ...(hasOfflineAccess(scope)
                ? { refresh_token: await refresh.issue({ userId: user.id, clientId: client.id, scope }) }
                : {}),
        }, { headers: cors });
    }

    return [
        {
            path: "/.well-known/openid-configuration",
            handle: (req, cors) => discovery(req, cors, "config"),
        },
        {
            path: "/.well-known/jwks.json",
            handle: (req, cors) => discovery(req, cors, "jwks"),
        },
        {
            path: "/oidc/token",
            method: "POST",
            async handle(req, cors) {
                const body = new URLSearchParams(await req.text());
                const grantType = body.get("grant_type");
                if (grantType === "refresh_token") {
                    return refreshGrant(body, req, cors);
                }
                if (grantType === DEVICE_CODE_GRANT) {
                    return deviceGrant(body, req, cors);
                }
                if (grantType !== "authorization_code") {
                    return Response.json({ error: "unsupported_grant_type" }, { status: 400, headers: cors });
                }
                const code = body.get("code");
                const redirectUri = body.get("redirect_uri");
                const codeVerifier = body.get("code_verifier");
                const creds = clientCredentials(req, body);
                if (!code || !redirectUri || !codeVerifier || !creds) {
                    return Response.json({ error: "invalid_request" }, { status: 400, headers: cors });
                }

                const client = await oidc.verifyClientSecret(creds.clientId, creds.clientSecret);
                if (!client) {
                    return Response.json({ error: "invalid_client" }, { status: 401, headers: cors });
                }
                const grant = oidc.consumeCode(code);
                if (!grant || grant.clientId !== client.id || grant.redirectUri !== redirectUri) {
                    return Response.json({ error: "invalid_grant" }, { status: 400, headers: cors });
                }
                if (!verifyPkce(codeVerifier, grant.codeChallenge)) {
                    return Response.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, { status: 400, headers: cors });
                }
                const user = auth.getUserById(grant.userId);
                if (!user) {
                    return Response.json({ error: "invalid_grant", error_description: "User no longer exists" }, { status: 400, headers: cors });
                }
                const config = await readConfig();
                if (!config.primaryUrl) {
                    return Response.json({ error: "server_error", error_description: "Primary URL is not configured" }, { status: 500, headers: cors });
                }

                const idToken = buildIdToken(user, {
                    issuer: config.primaryUrl,
                    clientId: client.id,
                    nonce: grant.nonce,
                    authTime: Math.floor(grant.issuedAt / 1000),
                    scope: grant.scope,
                    groupPrefix: effectiveGroupPrefix(client, apps),
                    knownAppNodes: auth.knownAppPermissions(),
                    declaredRoles: declaredRolesFor(client, apps),
                }, oidc.key);
                return Response.json({
                    ...tokenResponse(user, client, grant.scope, config.primaryUrl),
                    id_token: idToken,
                    // Only the initial exchange can start a chain; a refresh
                    // rotates an existing one instead.
                    ...(hasOfflineAccess(grant.scope)
                        ? { refresh_token: await refresh.issue({ userId: user.id, clientId: client.id, scope: grant.scope }) }
                        : {}),
                }, { headers: cors });
            },
        },
        {
            path: "/oidc/device_authorization",
            method: "POST",
            // RFC 8628 §3.1. Client authentication is the token endpoint's, per
            // spec — which for this provider means a client secret, since it has
            // no public clients. A device app therefore ships one, the same way
            // it would to use any other grant here.
            async handle(req, cors, ctx) {
                const config = await readConfig();
                if (!config.primaryUrl) {
                    return Response.json({ error: "server_error", error_description: "Primary URL is not configured" }, { status: 500, headers: cors });
                }
                const body = new URLSearchParams(await req.text());
                const creds = clientCredentials(req, body);
                if (!creds) {
                    return Response.json({ error: "invalid_request" }, { status: 400, headers: cors });
                }
                const client = await oidc.verifyClientSecret(creds.clientId, creds.clientSecret);
                if (!client) {
                    return Response.json({ error: "invalid_client" }, { status: 401, headers: cors });
                }
                let rec;
                try {
                    rec = devices.request({
                        clientId: client.id,
                        // `openid` alone is the useful floor: without it this
                        // mints an OAuth access token and no identity, which is
                        // never what a device pairing against an OIDC provider
                        // meant to ask for.
                        scope: body.get("scope") || "openid",
                        ip: ctx.clientIp,
                        userAgent: req.headers.get("user-agent"),
                    });
                } catch (err) {
                    if (err instanceof DeviceCapError) {
                        // Not one of §3.2's codes, because it has none for this.
                        // `slow_down` is the RFC's own word for "you are asking
                        // too often", and 429 is what a client's HTTP layer
                        // already knows to back off from.
                        return Response.json({ error: "slow_down", error_description: err.message }, { status: 429, headers: cors });
                    }
                    throw err;
                }
                const userCode = formatUserCode(rec.userCode);
                const verificationUri = `${config.primaryUrl}/device`;
                return Response.json({
                    device_code: rec.deviceCode,
                    user_code: userCode,
                    verification_uri: verificationUri,
                    // What the QR code on the television encodes, so the phone
                    // that scans it skips the typing entirely.
                    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
                    expires_in: Math.round((rec.expiresAt - Date.now()) / 1000),
                    interval: POLL_INTERVAL_S,
                }, { headers: cors });
            },
        },
        {
            path: "/oidc/revoke",
            method: "POST",
            // RFC 7009. Answers 200 whether or not the token existed: telling an
            // unauthenticated caller "that was a real token" is an oracle, and
            // the spec asks for 200 on unknown tokens for exactly that reason.
            async handle(req, cors) {
                const body = new URLSearchParams(await req.text());
                const token = body.get("token");
                const creds = clientCredentials(req, body);
                if (!creds || !await oidc.verifyClientSecret(creds.clientId, creds.clientSecret)) {
                    return Response.json({ error: "invalid_client" }, { status: 401, headers: cors });
                }
                if (token) {
                    await refresh.revoke(token);
                }
                return new Response(null, { status: 200, headers: cors });
            },
        },
        {
            path: "/oidc/userinfo",
            async handle(req, cors) {
                const token = bearerToken(req);
                const payload = token ? verifyJwt(token, oidc.key.publicKeyPem) : null;
                const sub = payload && typeof payload.sub === "string" ? payload.sub : null;
                const user = sub ? auth.getUserById(sub) : null;
                // Bind the response to the audience the token was minted for. A
                // valid signature alone used to be enough, so a token issued to
                // one client answered for every other — and the reply carried
                // every `app.*` grant regardless of what was asked for.
                const aud = payload && typeof payload.aud === "string" ? payload.aud : null;
                const client = aud ? oidc.getClient(aud) : null;
                if (!user || !client) {
                    return Response.json({ error: "invalid_token" }, { status: 401, headers: cors });
                }
                const scope = typeof payload?.scope === "string" ? payload.scope : "";
                return Response.json(scopedClaims(user, scope, effectiveGroupPrefix(client, apps), auth.knownAppPermissions(), declaredRolesFor(client, apps)), { headers: cors });
            },
        },
    ];
}


