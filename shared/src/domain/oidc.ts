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
    /** The App this client signs people into, if any. Supersedes `groupPrefix`:
     *  the App's slug *is* the prefix, defined once instead of retyped here. */
    appId: string | null;
    /** Which slice of the user's `app.*` grants this client is allowed to see.
     *  `"immich"` sends only `app.immich.*` in the `groups` claim; null sends
     *  every `app.*` node, which tells Jellyfin what roles you hold in Immich.
     *
     *  Retained for registrations made before Apps existed, which set it
     *  directly. `appId` wins where both are present; see `effectiveGroupPrefix`. */
    groupPrefix: string | null;
}

/**
 * One live refresh-token chain: an app that can keep signing in as this user
 * without them present.
 *
 * Listed separately from `UserSession` because it is a different thing that the
 * sessions list can no longer stand in for. A refresh token deliberately
 * outlives the login session that authorized it (a TV cannot re-run a browser
 * flow), so "sign out everywhere" and "this account's active sessions" stopped
 * describing the same set the moment refresh tokens existed.
 */
export interface AppGrant {
    /** Identifies the rotation chain — the unit of revocation, since rotation
     *  means the current token's value is a moving target. */
    familyId: string;
    clientId: string;
    /** Resolved for display; "(deleted client)" when the registration is gone. */
    clientName: string;
    scope: string;
    issuedAt: number;
    /** When the chain lapses if it is never refreshed again. */
    expiresAt: number;
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
 * A pending device authorization, as the `/device` approval screen sees it.
 *
 * Everything here except `appName` is request metadata rather than identity,
 * and that is the point: a television has no identity to show, so the address
 * and user-agent it asked from are the only evidence a human can actually weigh
 * before approving. It is also what defends the social-engineering variant,
 * where an attacker reads a victim their own code over the phone — an
 * unfamiliar address on the prompt is the tell.
 */
export interface DeviceAuthorizationRequest {
    /** Display form (`XXXX-XXXX`), echoed back so the screen can confirm what
     *  was matched rather than what was typed. */
    userCode: string;
    appName: string;
    scope: string;
    ip: string | null;
    userAgent: string | null;
    requestedAt: number;
    expiresAt: number;
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
    createClient: { data: { name: string; redirectUris: string[]; appId?: string | null }; response: { client: OidcClient; clientSecret: string } };
    /** Edit a registration in place, keeping its id and secret. A redirect URI
     *  is routinely a placeholder until the app is actually deployed, and
     *  delete-and-re-register to correct one means reconfiguring the app to fix
     *  a typo. `appId: null` clears the App link. */
    updateClient: { data: { client: OidcClient }; response: void };
    deleteClient: { data: { clientId: string }; response: void };
    /** Issue a fresh secret for an existing registration, keeping its client id.
     *  Without this, a lost secret means delete + re-register, which mints a new
     *  id and so means reconfiguring the app rather than pasting one value. */
    regenerateSecret: { data: { clientId: string }; response: { clientSecret: string } };
    /** Apps holding a live grant for one account, for the Users screen. */
    listGrants: { data: { userId: string }; response: AppGrant[] };
    /** Revoke one chain — the app must run a full authorization to come back. */
    revokeGrant: { data: { familyId: string }; response: void };
    getAuthorizeRequest: { data: OidcAuthorizeParams; response: { appName: string; redirectUri: string } };
    completeAuthorize: { data: OidcAuthorizeParams; response: { redirectUrl: string } };
    /** Resolve a code a human typed into `/device`. Null when nothing pending
     *  matches — expired, already answered, or simply mistyped, which are
     *  deliberately one answer rather than three. */
    getDeviceRequest: { data: { userCode: string }; response: DeviceAuthorizationRequest | null };
    /** Approve a pending device authorization, minting the grant the device
     *  collects on its next poll. */
    approveDevice: { data: { userCode: string }; response: void };
    denyDevice: { data: { userCode: string }; response: void };
}
