import type { OidcAuthorizeParams, OidcClient } from "@central/shared";
import type { AuthContext } from "../../auth";
import { readConfig } from "../../config";
import type { Feature, FeatureApiHandlers } from "../../feature";
import type { OidcStore } from "./store";

// An OIDC client is a relying-party registration (id/secret + redirect URIs) for
// Central's built-in OIDC provider — unrelated to the App entity (compose stacks
// on a host) the apps feature owns.

export function createOidcFeature(oidc: OidcStore): Feature<OidcOps> {
    return {
        descriptor: {
            id: "oidc",
            name: "OIDC provider",
            description: "Central's built-in OpenID Connect provider and its client registrations.",
            experimental: false,
            dependsOn: ["auth"],
        },
        async init() {
            await oidc.init();
        },
        apiHandlers() {
            return oidcApiHandlers(oidc);
        },
    };
}

export type OidcOps = "listOidcClients" | "createOidcClient" | "deleteOidcClient"
    | "getOidcAuthorizeRequest" | "completeOidcAuthorize";

export function oidcApiHandlers(oidc: OidcStore): FeatureApiHandlers<OidcOps> {
    return {
        // ---- Client registrations (owner-only admin) ---------------------------

        async handleListOidcClients(_data: void, ctx?: AuthContext): Promise<OidcClient[]> {
            return oidc.listClients();
        },

        async handleCreateOidcClient(data: { name: string; redirectUris: string[] }, ctx?: AuthContext): Promise<{ client: OidcClient; clientSecret: string }> {
            const config = await readConfig();
            if (!config.primaryUrl) {
                throw new Error("Set a Primary URL in Settings before registering OIDC clients");
            }
            return oidc.createClient(data.name, data.redirectUris);
        },

        async handleDeleteOidcClient(data: { clientId: string }, ctx?: AuthContext): Promise<void> {
            await oidc.deleteClient(data.clientId);
        },

        // ---- Front-channel (authenticated user) --------------------------------
        //
        // Driven by the SPA's /oidc/authorize route: it resolves the request to
        // show "Continue as X to <app>?", then mints the code on confirm. The
        // actual code-for-token exchange is raw HTTP at POST /oidc/token (see
        // index.ts), since that leg is called by the relying party's backend, not
        // the browser.

        async handleGetOidcAuthorizeRequest(data: OidcAuthorizeParams): Promise<{ appName: string; redirectUri: string }> {
            const app = oidc.validateRequest(data);
            return { appName: app.name, redirectUri: data.redirectUri };
        },

        async handleCompleteOidcAuthorize(data: OidcAuthorizeParams, ctx?: AuthContext): Promise<{ redirectUrl: string }> {
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
    };
}
