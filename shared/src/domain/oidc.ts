// ---- OIDC provider -----------------------------------------------------------------
//
// A client is a relying party registered by the owner to sign in via Server
// Central's built-in OpenID Connect provider (no dynamic client registration) —
// just OIDC credentials (id/secret + redirect URIs). Independent of the
// ComposeStack entity below: an OIDC client is usually something SC does *not*
// run, and a stack usually has no login to register. (Historical note, since it
// explains some churn in git: this type was briefly named `App` as a placeholder,
// and the name later went to the compose-stack concept before that was renamed
// again to `ComposeStack`.) Roles are exposed as a `groups` claim on the ID
// token. See apps/server/src/features/oidc/ for the provider implementation.

export interface OidcClient {
    id: string;
    name: string;
    redirectUris: string[];
    createdAt: number;
}

/** Query params an authorization request carries, whether read from the RP's
 *  redirect (`GET /oidc/authorize`) or forwarded by the SPA's confirm screen. */
export interface OidcAuthorizeParams {
    clientId: string;
    redirectUri: string;
    scope: string;
    state: string;
    codeChallenge: string;
    codeChallengeMethod: "S256";
    nonce?: string;
}


/**
 * Client administration (owner-only) plus the front-channel operations driven
 * by the `/oidc/authorize` SPA route. The code-for-token exchange happens over
 * raw HTTP at `POST /oidc/token` (form-encoded, per spec), not through this RPC
 * layer — see the oidc feature's `httpRoutes`.
 */
export interface OidcOperations {
    listClients: { data: void; response: OidcClient[] };
    /** clientSecret is returned once, at creation, and never again. */
    createClient: { data: { name: string; redirectUris: string[] }; response: { client: OidcClient; clientSecret: string } };
    deleteClient: { data: { clientId: string }; response: void };
    getAuthorizeRequest: { data: OidcAuthorizeParams; response: { appName: string; redirectUri: string } };
    completeAuthorize: { data: OidcAuthorizeParams; response: { redirectUrl: string } };
}
