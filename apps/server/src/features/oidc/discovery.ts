import type { OidcDiscoveryDocument, OidcProviderInfo } from "@central/shared";

/** Builds the `/.well-known/openid-configuration` document. `issuer` is the
 *  admin-configured, stable base URL (see config.ts `primaryUrl`) — not derived
 *  from the incoming request, since it must stay fixed once clients trust it. */
export function discoveryDocument(issuer: string): OidcDiscoveryDocument {
    return {
        issuer,
        authorization_endpoint: `${issuer}/oidc/authorize`,
        token_endpoint: `${issuer}/oidc/token`,
        userinfo_endpoint: `${issuer}/oidc/userinfo`,
        device_authorization_endpoint: `${issuer}/oidc/device_authorization`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        scopes_supported: ["openid", "profile", "email", "groups", "offline_access"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        code_challenge_methods_supported: ["S256"],
        claims_supported: ["sub", "iss", "aud", "exp", "iat", "auth_time", "preferred_username", "email", "email_verified", "groups"],
        grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
        revocation_endpoint: `${issuer}/oidc/revoke`,
    };
}

/** What the SSO screen shows an admin to copy into another app — the same
 *  document `/.well-known` serves, plus where to fetch it from. */
export function providerInfo(issuer: string): OidcProviderInfo {
    return {
        discoveryUrl: `${issuer}/.well-known/openid-configuration`,
        discovery: discoveryDocument(issuer),
        groupsClaim: "groups",
    };
}
