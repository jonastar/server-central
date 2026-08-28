Known-broken behaviour, waiting to be fixed. Anything fixed is recorded in
[changelog.md](changelog.md), not here. Missing/unimplemented work lives in
[next.md](next.md); accepted-at-this-scale tradeoffs in [known_issues.md](known_issues.md).

- Deploying the reverse proxy creates a temporary error thing? Weird.
- An outdated agent ignores `openShell.asUser` and opens a **root** shell — an impersonated
  terminal silently fails open to root instead of the caller's mapped user. Wants a
  minimum-agent-version gate on impersonated shells.

## Public endpoints accept cross-origin writes

`setupOwner` is in `PUBLIC_COMMANDS` (`apps/server/src/index.ts`), and a cross-origin POST
reaches it: with `Content-Type: text/plain` the request is CORS-"simple", so no preflight
happens and `req.json()` parses the body regardless of the declared type. Confirmed against a
fresh instance — any page a user visits can claim ownership of an un-setup control plane
reachable from their browser (a LAN address, typically).

`allowedOrigins` does **not** close this: CORS governs whether the response can be *read*, not
whether the request is *delivered*. The fix is a request-level check — reject a state-changing
request whose `Origin` is present and matches neither the host it arrived on
(`Host`/`X-Forwarded-Host`) nor `allowedOrigins`. Browsers always send `Origin` cross-origin and
page JS can't forge it. Cheap, and worth doing before anyone runs this anywhere exposed.
