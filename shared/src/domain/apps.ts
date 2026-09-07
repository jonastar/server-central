// ---- Apps --------------------------------------------------------------------
//
// An App is the thing a person thinks they installed — "Immich" — as opposed to
// the pieces Server Central manages on its behalf: a compose stack that runs it,
// an OIDC client that signs people into it, proxy routes that expose it, and
// (later) a route group's auth policy.
//
// This is the **spine** of the system designed in doc/idea_app_system.md, and
// deliberately only that: identity, plus the role names the app understands. It
// owns no runtime, no directory and no lifecycle. Sub-resources keep their own
// stores and point *at* an App by `appId` — never the reverse — so each stays
// valid standalone, which is the decision recorded in next.md (2026-08-21): an
// OIDC client is usually something SC doesn't run, and a stack usually has no
// login.
//
// It exists now because the alternative is worse. Wiring one app up today means
// retyping its name as a bare string in three unvalidated places — the OIDC
// client's group prefix, each user's `app.<name>.*` grants, and (next) a proxy
// route group's required permissions. The third one is a lockout a typo can
// cause. One record, defined once, is what makes those a reference instead.

export interface App {
    id: string;
    /** Namespace segment: the `app.<slug>.*` permission prefix, and what the
     *  OIDC `groups` claim is filtered by. Lowercase, one segment, unique. */
    slug: string;
    /** Display name. Free text — `slug` carries the identity. */
    name: string;
    /**
     * Role names this app understands, unqualified: `"admin"` means
     * `app.<slug>.admin`.
     *
     * SC never learns what they mean — they are payload for the app, and the
     * `app.*` namespace stays open by design. Declaring them per app is what
     * turns "open namespace" into "closed list, per app", which is what a
     * dropdown and typo detection need. Empty is fine and means "not declared".
     */
    roles: string[];
    createdAt: number;
}

/** The `app.<slug>.<role>` node a declared role corresponds to. */
export function appRoleNode(app: Pick<App, "slug">, role: string): string {
    return `app.${app.slug}.${role}`;
}

/**
 * App registry. CRUD only — an App has no runtime to act on in this version.
 *
 * `delete` refuses while an OIDC client still references the App, rather than
 * leaving a dangling `appId`: an unresolvable reference falls back to "send
 * every `app.*` node", so a silent delete would silently *widen* what a relying
 * party is told about the user.
 */
export interface AppOperations {
    list: { data: void; response: App[] };
    create: { data: { name: string; slug: string; roles?: string[] }; response: App };
    update: { data: { app: App }; response: void };
    delete: { data: { appId: string }; response: void };
}
