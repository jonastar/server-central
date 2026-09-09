# Sign-in methods and the identity provider

Status: in progress. Phases 0-2 shipped (`a2401da`, `64f9e86`, `f71f047`, `9ba4e2e`, `9cc968c`);
phases 3-4 are still plan. §0 and §7 are settled; four items remain open at the end of §7.

Scope: the **left column** — how a human or device proves who they are, and what the
built-in OIDC provider hands out afterwards. The **right column** (gate cookie, forward-auth
verifier, route groups, device tokens for non-browser clients) stays in
[idea_proxy_auth_gateway.md](idea_proxy_auth_gateway.md); this doc supersedes its §6
("Closing the SSO gaps"), which is folded in below.

```
authentication methods (N)        →   SC session   →   presentations (M)
  username + password                  (one record)      bearer token  → SPA
  federated (Google / generic OIDC)                      gate cookie   → proxied apps  ─┐
  device grant (TV, quick connect)                       device header → Immich mobile ─┴ gateway doc
```

The middle column stays singular. That is the load-bearing constraint: every method mints
the same `SessionRecord`, and every presentation reads it. Methods are pluggable, sessions
are not.

## 0. Decisions taken

- **The verify endpoint is not the login page.** Two components: a machine endpoint that
  answers Caddy's subrequest with 204/302/403 and never emits HTML, and an SPA gate page the
  302 points at. Already the shape in the gateway doc's §3 — restated here because the
  conversation that produced this plan kept collapsing them.
- **The verify endpoint gets its own socket in v2, not v1.** The attack-surface argument is
  real but the split is cheap to defer, *provided* the route never grows a dependency on the
  `/api` machinery (the `Origin` check in [`cors.ts`](../apps/server/src/cors.ts), the RPC
  dispatcher, `AuthContext` threading). Keep it a raw route in the `/oidc/token` mould.
- **Quick connect is RFC 8628 (OAuth 2.0 Device Authorization Grant), not a bespoke
  protocol.** See §3 for why.
- **Refresh tokens are promoted from polish to blocker**, because a TV cannot re-run an
  authorization flow every hour.
- **Federation is one generic OIDC relying-party implementation**, with Google as the first
  configured provider. Named per-provider integrations are config rows, not code.
- **Federation is allowed to become the owner's only door.** Accepted risk: recovery is
  "SSH into the control plane host". That is only true once phase 0 ships.

## 1. Phase 0 — make the accepted risk true — **shipped `a2401da`**

Small, and a prerequisite for the federation decision above rather than for any feature.

- **`--reset-password <username>`** on the control-plane binary, alongside `--agent` and
  `--install-server` in [`index.ts`](../apps/server/src/index.ts). Loads `AuthStore` against
  the data dir, prompts for a new password on the TTY, writes it, and revokes that user's
  sessions (`adminSetPassword` already does the last two). Needs `--data-dir` for parity with
  the install CLI. Without this, "SSH in and fix it" means hand-crafting a `Bun.password`
  argon2id hash into `users.json`.
- Consider `--make-owner <username>` too, for the case where the owner record is gone rather
  than just locked.
- **Delete `console.log(this.users)`** at [`auth.ts:97`](../apps/server/src/auth.ts#L97). It
  dumps every account's argon2id hash into journald on every boot. Unrelated to this plan,
  one line, do it here.

## 2. Phase 1 — email and claim correctness — **shipped `64f9e86`, `f71f047`**

The gap that actually blocks Immich today: `UserRecord` has no email, and Immich's OAuth
defaults to scope `openid email profile` and keys accounts on `email`.

**Storage.** `email?: string` on `UserRecord` — optional (decided, §7), absent on existing
records, which is the same as unset. No migration, matching how `extraPermissions` and
`systemUser` were added. `UserInfo` in
[`shared/src/domain/auth.ts`](../shared/src/domain/auth.ts) carries it so the Users admin
screen can show and edit it.

**Normalized and unique.** Lowercase + trim on write, mirroring `normalizeUsername` in
[`auth.ts`](../apps/server/src/auth.ts), and rejected if another account already holds it.
Not cosmetic: Immich keys accounts on `email`, so two SC accounts sharing one address
produces a single shared Immich account, which is confusing to debug from the Immich side
and impossible to untangle afterwards.

**There is no `email_verified` field, and no verification flow.** The claim is emitted, and
it is always `true`. The reasoning, since "always true" looks lazy and isn't:

- SC has **no self-signup**. An address enters the store one of two ways: the owner typed it
  in, or federation accepted it from an upstream — and phase 4 refuses to auto-create or
  auto-link on an upstream `email_verified: false` (§5). By construction every stored address
  is either owner-asserted or upstream-verified.
- In this trust model the owner *is* the authority on their own household's addresses. There
  is no attacker positioned between the owner and the text field, which is the only thing a
  confirmation-link flow would defend against.
- A field that is structurally always `true` is not a field. Storing it would invite a future
  `false` that nothing in the system knows how to produce.

The inbound direction is a **different concern with the same name**: reading *Google's*
`email_verified` off an upstream token before linking. That is a condition in phase 4's
linking code, not a column here. Do not let the shared name merge them.

**`groups` becomes per-client.** Today every client receives the user's entire `app.*` set,
so Jellyfin learns you hold `app.immich.admin` — a needless leak between apps, and the reason
scoping the claim belongs here rather than later. Add `groupPrefix?: string` to
`OidcClientRecord` ([`store.ts`](../apps/server/src/features/oidc/store.ts)); when set,
`groups` filters to `app.<prefix>.*`. Cheap, and it also gives the Users screen the
per-client dropdown of known role names that `next.md` already wants in place of free text.

**Claims become scope-aware.** [`buildIdToken`](../apps/server/src/features/oidc/tokens.ts)
emits unconditionally today; `profile` is advertised in discovery and adds nothing. After:

| scope | claims |
|---|---|
| `openid` | `sub`, `iss`, `aud`, `exp`, `iat`, `auth_time`, `nonce` |
| `profile` | `preferred_username` |
| `email` | `email`, `email_verified` |
| `groups` | `groups` (still `app.*` only) |

Harmless today, wrong the moment a strict RP checks — and the device flow in §3 makes a
strict RP more likely.

**`/oidc/userinfo` must check `aud`.** It currently accepts any token this server signed,
including one minted for a different client
([`feature.ts:170`](../apps/server/src/features/oidc/feature.ts#L170)). Verify `aud` against
the presenting client and filter the response by the token's recorded scope. This means the
access token needs its scope readable at verify time — it already carries `scope`, so this is
a check, not a schema change.

**Discovery** gains `email` in `scopes_supported` and `email`/`email_verified` in
`claims_supported`.

**Missing-email behaviour.** An RP asking for `email` scope for a user who has none should
fail the authorize with a legible error, not silently omit the claim — a silent omission makes
Immich create a broken account that is then annoying to reconcile. See §7 Q1 for whether email
is mandatory at account creation.

**The owner needed its own answer**, which this plan did not anticipate. Its permission set
is the single node `*`; filtering that for `app.*` yields nothing, so the control plane's most
privileged account would have signed into every app as its least privileged user. Since
`app.*` is an open namespace there is no registry to expand `*` against, so the owner receives
the union of: every `app.*` node the installation actually uses
(`AuthStore.knownAppPermissions`), any app nodes on the account itself, and — for a client
declaring a `groupPrefix` — the conventional `app.<prefix>.admin` leaf, so a freshly
registered app that nobody holds grants for yet still admits the owner as an admin.

That last part is a **convention, not knowledge**: an app whose admin role is named something
else needs the node granted explicitly. The proper fix is a per-client list of declared role
names, which replaces the guess with a fact and gives the Users screen the dropdown `next.md`
already wants in place of free-text app roles. Tracked in "Still open" below.

**Tests.** [`oidc.test.ts`](../apps/server/test/integration/oidc.test.ts) covers the store and
token layer well and stops at the HTTP boundary. Extend it for scope filtering and the `aud`
check, and add the first real-RP-against-a-real-server case using the `verify` skill and the
e2e lab.

## 3. Phase 2 — refresh tokens — **shipped `9cc968c`**

A 1h access token with no refresh means the RP re-runs the whole flow hourly. Tolerable for a
browser (silent, once §5 auto-continue exists), fatal for a TV.

- **`offline_access`** is the standard OIDC scope (OIDC Core 1.0 §11) meaning "also issue me
  a refresh token". Nothing exotic — it is the opt-in, so an RP that only needs a one-shot
  login does not silently receive a long-lived credential. It is a scope check at the token
  endpoint, not a subsystem. Add it to `scopes_supported`; `grant_type=refresh_token` at
  `/oidc/token` redeems it.
- **Rotation on use**, with reuse detection: presenting a rotated-out token revokes the whole
  family. Standard, and cheap to build now.
- **First persistent OIDC credential.** Authorization codes are deliberately in-memory
  ([`store.ts`](../apps/server/src/features/oidc/store.ts) — single-use, 60s, a restart just
  fails that attempt). Refresh tokens cannot be: a TV must survive a control-plane restart.
  New file, hashed at rest like client secrets.
- **Revocation has to fan out.** Deleting a user, or an admin revoking sessions, must kill
  their refresh tokens — otherwise `deleteSessionsForUser` becomes a lie the moment an RP
  holds a refresh token. Add `/oidc/revoke` (RFC 7009) while the code is open.
- Discovery gains `refresh_token` in `grant_types_supported`.
- **Make the signing key a list while this file is open** (answers §7 Q5). `SigningKey` is a
  single object today and `jwks()` returns a one-element array. Change the store to hold
  `keys: SigningKey[]` with one marked active: sign with the active key, verify against any,
  publish all. Roughly twenty lines now, and it turns future rotation into an operation
  rather than a refactor. `kid` is already emitted on both the JWT header and the JWKS entry,
  so relying parties are already prepared for more than one. Do **not** build a rotation
  schedule yet — just stop assuming there is exactly one key. This matters more once refresh
  tokens exist, because they stretch the window in which an old key must stay verifiable.
- **Revocation now needs its own UI.** Because a refresh token outlives the SC session that
  authorized it (decided, §7 Q3), the sessions list in the Users screen no longer describes
  everything holding access. It needs a sibling list — *Connected apps & devices* — with its
  own revoke. Decide explicitly what the existing actions do to it: `adminSetPassword` should
  revoke app grants too (it is a compromise-response action), ordinary `logout` should not.

## 4. Phase 3 — device grant / quick connect

For TVs and anything else with a screen and no usable keyboard.

```
TV  → POST /oidc/device_authorization   → { user_code: "BDWD-HQPK",
                                            verification_uri, verification_uri_complete,
                                            device_code, interval, expires_in }
TV  displays the code, plus a QR of verification_uri_complete
You → open /device in the web UI, enter the code, approve
TV  → polls POST /oidc/token (grant_type=…:device_code) → tokens
```

**Why the standard rather than a bespoke flow.** The described UX falls out of it for free —
`verification_uri` *is* the settings page where you type a code, so the standard and the
desired UX are one build. Any TV app that already speaks OAuth already speaks this; a custom
scheme means only clients we write can use it. And the direction is right: the device
displays, the human types into a browser. The reverse is D-pad text entry, which is the thing
being avoided.

**Shape.**

- `POST /oidc/device_authorization` — a raw HTTP route, same reasoning as `/oidc/token`.
- **User codes** use a confusable-free alphabet (no `0`/`O`, `1`/`I`/`l`) per RFC 8628 §6.1,
  formatted `XXXX-XXXX`. Deliberately low entropy, which is what makes §6 mandatory.
- **Device codes** are high-entropy random, like authorization codes.
- Pending grants stay **in memory** alongside `codes` — a ~5 minute TTL means a restart
  costing one re-pair is acceptable, and it keeps the hot path off disk.
- `/oidc/token` gains the device-code grant with its `authorization_pending`, `slow_down`,
  `access_denied`, `expired_token` responses.
- New SPA route `/device`, and a "Connect a device" entry point in Settings. New session-level
  ops (`getDeviceRequest`, `approveDevice`, `denyDevice`) in `SESSION_OPS` alongside the
  existing authorize ops.
- Discovery gains `device_authorization_endpoint` and the grant type.

**This half-solves the gateway doc's §7.** A long-lived, revocable, per-device grant is the
same record whether it was minted by a device flow (a TV, which speaks the protocol) or by a
"generate token" button in Settings (the Immich mobile app, which does not). One credential
type, two ways to mint. The header-presentation half stays in the gateway doc.

### The failure mode is typo collision, not brute force

An earlier draft of this plan called for hard throttling because user codes are guessable.
That aimed at the wrong threat. Guessing a user code that *someone else's* TV is displaying
and approving it just authorizes their TV — it helps them. The credential where guessing
would actually steal tokens is the `device_code` the TV polls with, and that one is
high-entropy random precisely so it cannot be.

The real failure mode is duller and much more likely:

1. An attacker opens a few thousand device authorization requests. The endpoint is
   unauthenticated and cheap, so nothing stops this today.
2. A legitimate user starts their TV, reads `BDWD-HQPK`, and **mistypes one character**.
3. They land on an attacker's pending code, see a generic "approve this device?" prompt,
   approve, and hand that attacker a session.

No guessing is involved on the attacker's side. They only need enough live codes that a
plausible typo lands on one. Which makes the mitigations these:

- **Cap concurrent pending authorizations** — globally and per source IP. This is the actual
  control, and the honest framing of what the throttle is for: not anti-guessing, but keeping
  the active set small enough that a typo has nowhere to land. Reuse the shape of
  `MAX_LOGIN_FAILURES` / `LOGIN_BLOCK_MS` in [`auth.ts`](../apps/server/src/auth.ts) rather
  than inventing a second throttle.
- **Enforce a minimum edit distance across the active set.** Generate by rejection sampling
  so every pending code differs from every other in at least two positions, making any
  single-character typo structurally incapable of hitting another live code. Only tractable
  because of the cap above — the two mitigations are a pair, not alternatives. At family
  scale the active set is single digits and rejection sampling is free.
- **Short TTL** — 5 minutes, not the RFC's more permissive default. Bounds the active set
  from the other direction.
- **The approval screen shows the requesting IP (with coarse geolocation) and user-agent.**
  A TV has no identity to display, so the request metadata is the only evidence the user can
  actually weigh. This is also what defends the social-engineering variant — attacker reads a
  victim a code over the phone — where an unfamiliar city on the prompt is the tell.

## 5. Phase 4 — federated login

SC as a relying party, as an *additional* credential type. SC still owns the account record,
the roles, the `systemUser` mapping and the `app.*` grants: upstream authenticates, SC
authorizes. This is the distinction that makes federation safe here — it is not delegating
identity authority, which the gateway doc's whole permission model depends on retaining.

- **`identities: [{ provider, subject, email }]` on `UserRecord`.** Keyed on `subject`, never
  email — emails change hands. Cheap to add now, a migration later.
- **One generic OIDC RP implementation**, configured per provider (issuer, client id, secret,
  scopes) with discovery fetched from the issuer. Google, Microsoft, Authentik and Keycloak
  then differ only by config. **Apple is the exception** — private-relay addresses and a
  `client_secret` that is itself a JWT needing re-minting every six months. Do it last, if at
  all.
- **This is new code, not a reuse of the provider.**
  [`verifyJwt`](../apps/server/src/features/oidc/tokens.ts) verifies against *our* key;
  validating an upstream's ID token needs JWKS fetching, caching and rotation handling. Its
  own feature directory.
- **The callback is a top-level navigation**, so the minted session token reaches the SPA in
  the URL **fragment**, not the query string — a query lands in access logs and `Referer`.
  Same constraint the gateway doc notes for its gate page.
- **Account linking is explicit by default.** Auto-linking an upstream identity to an existing
  account by matching email is a privilege-escalation vector whenever the upstream does not
  actually verify the address. Link from an already-authenticated session; permit auto-create
  only behind an owner-enabled "allow sign-up via this provider" setting.
- **This is where `email_verified` is read** — the upstream's claim, on the upstream's token,
  as a precondition for auto-create or auto-link. Refuse both when it is false or absent and
  fall back to explicit linking. This check is what makes §2's "we always assert verified"
  a true invariant rather than an assumption.

## 5a. Where the sign-in surfaces live

Three interstitial pages, easily conflated, that differ in what they mint:

| Route | Reached from | Mints |
| --- | --- | --- |
| `/login` | no session anywhere | an SC session |
| `/oidc/authorize` | a relying party's code flow | an OIDC authorization code |
| `/gate` | Caddy's forward-auth 302 | a gate cookie, then bounces back |

They share the login form and the "you arrived from somewhere, return there" shell, and
should be one component family — but the gate page is **not** the OIDC page, and building
the second one as if it were will produce a page that mints the wrong credential.

Forward auth needs no screen of its own: its policy lives on the proxy **route group**
(gateway doc §4), as a section of the Proxy view that already exists.

## 6. Cross-cutting

### Where this code lives (answers §7 Q6)

Auth is the one part of the server that never adopted the
[feature convention](idea_feature_convention.md). Every other feature keeps its store at
`features/<id>/store.ts`; auth's is a 490-line
[`auth.ts`](../apps/server/src/auth.ts) at `src/` root, with
[`roles.ts`](../apps/server/src/roles.ts) beside it and only a 106-line `feature.ts` in
`features/auth/`. Federation would add a third store, so this is the moment to fix it rather
than the moment to add to the sprawl.

```
features/auth/          ways in — accounts, sessions, login methods
  store.ts              (was src/auth.ts)
  roles.ts              (was src/roles.ts)
  federation/           phase 4: upstream OIDC clients, JWKS cache, linking
  feature.ts
features/oidc/          the way out — SC as identity provider, unchanged
```

The line between the two directories is *direction*: `features/auth/` is every way a human or
device gets a session; `features/oidc/` is the service SC offers to relying parties. Folding
the provider into an auth mega-module would blur that, and it already has its own clean
permission nodes (`panel.oidc.*`).

One constraint: `AuthContext` is imported by nearly every feature (7 importers of `auth.ts`
today, and every `ops` signature mentions the type). Move the *type* to
`@central/shared` as part of this, so the churn is one import rewrite rather than a new
cross-feature dependency on `features/auth/`. Do the move in phase 0 or 1, while the files
are still small — not in phase 4 alongside new behaviour.

### `SessionRecord.method`

`SessionRecord` in [`auth.ts:31`](../apps/server/src/auth.ts#L31) records `ip`, `userAgent`
and timestamps but not *how* the session was obtained. Add
`method: "password" | "federated:<provider>" | "device"` in phase 0 or 1 — it is free now, it
surfaces in the existing admin sessions list as "signed in via Google on an Apple TV", and it
is the hook for any future policy that wants to treat methods differently (§7 Q4).

## 7. Questions, answered 2026-09-06

1. **Is email mandatory?** No — optional for now. Phase 1 stores it as an optional field; an
   RP requesting `email` scope for a user without one fails the authorize with a legible
   error rather than silently omitting the claim.
2. **Do device-grant sessions hold the full permission set?** No, narrower — and it is two
   existing mechanisms rather than new machinery. *Audience*: a token minted for the Jellyfin
   client already carries `aud: <clientId>` and is rejected elsewhere once phase 1 adds the
   missing `aud` check. *Claims*: `groupPrefix` on the client record (§2) filters `groups` to
   that app's nodes, so Jellyfin never learns about `app.immich.*`. Both land in phase 1, and
   the device grant then inherits the scoping for free.
3. **Does an OIDC refresh token outlive the SC session that authorized it?** Yes — it is a
   separate session. Consequence, tracked in §3: the Users screen grows a *Connected apps &
   devices* list beside *Sessions*, and password reset revokes both while logout revokes only
   the session.
4. **Does `method` gate anything?** Deferred to its own milestone. There is a PIN-for-dangerous-
   actions idea that wants real design first; it is not a rider on this plan. Keep the `method`
   field as the hook so that milestone starts with the data it needs.
5. **Signing key rotation.** Store a list of keys with one active now (§3); build no rotation
   schedule yet.
6. **Where does provider config live?** In a reorganized `features/auth/` — see §6.

### Still open

- ~~Refresh token **lifetime**~~ — 60 days, sliding (each rotation restarts it), independent
  of `SESSION_TTL_MS`. Spent links are remembered for 7 days so a prompt replay still takes
  the chain down; a replay after that is refused but no longer revokes the family.
- The **cap** on concurrent pending device authorizations (§4) — a real number, global and
  per-IP.
- Whether federated **auto-create** is off by default, or off entirely in v1 with explicit
  linking the only path.
- ~~**Per-client declared role names.**~~ Answered structurally by the App registry
  (`b469bfd`, [idea_app_system.md](idea_app_system.md)): roles are declared on the **App**
  rather than per client — several clients can front one app, and the names belong to the
  app either way. Both consumers landed in `9cc968c`: the Users permission editor renders
  them as checkboxes, and the owner's `*` expands to them instead of the guessed `.admin`.

## 8. Ordering

Phases 0–3 are pure identity-provider work with no dependency on the proxy, so each ships and
is useful before any of the gateway exists.

0. ~~Recovery CLI + the log-leak fix (§1)~~ — done, `a2401da`
1. ~~Email, scope-aware claims, `aud` check on userinfo, per-client group scoping (§2)~~ —
   done, `64f9e86` (server) and `f71f047` (UI). Immich-via-SC-SSO is unblocked; what remains
   before calling it proven is a real relying party against a real server, which the `verify`
   skill and the e2e lab exist for.
2. ~~Refresh tokens (§3)~~ — done, `9cc968c`. Also retired the owner's guessed
   `.admin` leaf: where an App declares its roles the owner gets those instead.
3. Device grant + `/device` page (§4) — **next**. Refresh tokens were its hard
   prerequisite, so nothing blocks it now.
4. Federated login, generic OIDC + Google (§5)

Then the gateway doc's §2–§4 (gate session, verifier, route groups) picks up, unchanged.
