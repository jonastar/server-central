/** Builds the `/.well-known/openid-configuration` document. `issuer` is the
 *  admin-configured, stable base URL (see config.ts `primaryUrl`) — not derived
 *  from the incoming request, since it must stay fixed once clients trust it. */
export function discoveryDocument(issuer: string): Record<string, unknown> {
    return {
        issuer,
        authorization_endpoint: `${issuer}/oidc/authorize`,
        token_endpoint: `${issuer}/oidc/token`,
        userinfo_endpoint: `${issuer}/oidc/userinfo`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid", "profile", "groups"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        code_challenge_methods_supported: ["S256"],
        claims_supported: ["sub", "iss", "aud", "exp", "iat", "auth_time", "preferred_username", "groups"],
        grant_types_supported: ["authorization_code"],
    };
}
