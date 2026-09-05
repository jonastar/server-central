import type { OidcAuthorizeParams, OidcClient } from "@central/shared";
import type { AuthStore, AuthContext } from "../../auth";
import { readConfig } from "../../config";
import type { HttpRoute } from "../../feature";
import { defineFeature } from "../../feature";
import type { OidcStore } from "./store";
import { discoveryDocument } from "./discovery";
import { ACCESS_TOKEN_TTL_S, buildAccessToken, buildIdToken, jwks, verifyJwt, verifyPkce } from "./tokens";

// An OIDC client is a relying-party registration (id/secret + redirect URIs) for
// Central's built-in OIDC provider — unrelated to the App entity (compose stacks
// on a host) the apps feature owns.

export const createOidcFeature = (oidc: OidcStore, auth: AuthStore) => defineFeature({
    id: "oidc",
    name: "OIDC provider",
    description: "Central's built-in OpenID Connect provider and its client registrations.",
    experimental: false,
    dependsOn: ["auth"],
    
    async init() {
        await oidc.init();
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
            return oidc.createClient(data.name, data.redirectUris);
        },

        async deleteClient(data, ctx?: AuthContext) {
            await oidc.deleteClient(data.clientId);
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
            const app = oidc.validateRequest(data);
            const code = oidc.issueCode({
                userId: ctx.user.id,
                clientId: app.id,
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
    },
    httpRoutes: () => oidcHttpRoutes(oidc, auth),
});

// ---- Raw HTTP endpoints ---------------------------------------------------------
//
// The parts of OIDC that can't be RPC operations. `/.well-known/*` are public GETs
// at paths fixed by spec; `/oidc/token` is called by the relying party's *backend*,
// so it's `application/x-www-form-urlencoded` and authenticates with the client's
// own credential (client_secret_post or HTTP Basic) rather than a session bearer
// token. `GET /oidc/authorize` needs no entry — it's a plain browser navigation
// that falls through to the SPA shell, and the React app recognizes the path.

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

export function oidcHttpRoutes(oidc: OidcStore, auth: AuthStore): HttpRoute[] {
    async function discovery(_req: Request, cors: Record<string, string>, which: "config" | "jwks"): Promise<Response> {
        const config = await readConfig();
        if (!config.primaryUrl) {
            return Response.json({ error: "Primary URL is not configured" }, { status: 404, headers: cors });
        }
        const body = which === "jwks" ? jwks(oidc.key) : discoveryDocument(config.primaryUrl);
        return Response.json(body, { headers: cors });
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
                if (body.get("grant_type") !== "authorization_code") {
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

                const key = oidc.key;
                const idToken = buildIdToken(user, { issuer: config.primaryUrl, clientId: client.id, nonce: grant.nonce, authTime: Math.floor(grant.issuedAt / 1000) }, key);
                const accessToken = buildAccessToken(user, { issuer: config.primaryUrl, clientId: client.id, scope: grant.scope }, key);
                return Response.json({
                    access_token: accessToken,
                    id_token: idToken,
                    token_type: "Bearer",
                    expires_in: ACCESS_TOKEN_TTL_S,
                    scope: grant.scope,
                }, { headers: cors });
            },
        },
        {
            path: "/oidc/userinfo",
            async handle(req, cors) {
                const token = bearerToken(req);
                const payload = token ? verifyJwt(token, oidc.key.publicKeyPem) : null;
                const sub = payload && typeof payload.sub === "string" ? payload.sub : null;
                const user = sub ? auth.getUserById(sub) : null;
                if (!user) {
                    return Response.json({ error: "invalid_token" }, { status: 401, headers: cors });
                }
                return Response.json({ sub: user.id, preferred_username: user.username, groups: user.permissions.filter((p) => p.startsWith("app.")) }, { headers: cors });
            },
        },
    ];
}


