/**
 * Which origins may read API responses cross-origin.
 *
 * The web UI itself needs none of this — it's served from the same origin as the
 * API, so its requests aren't cross-origin at all. This exists for deliberate
 * cross-origin callers (a script, another app's frontend), and defaults to the
 * historical `*` so nothing that works today stops working.
 *
 * Worth knowing what this does and doesn't buy: `Access-Control-Allow-Origin`
 * governs whether a browser hands the *response* back to the calling page. It does
 * not stop the request being *sent* — a "simple" cross-origin POST (e.g.
 * `Content-Type: text/plain`) skips preflight entirely and reaches the handler
 * whatever this says. That gap is closed separately, at request level, by
 * {@link originAllowsRequest} below; this file holds both halves.
 */

/** Origin of a URL ("https://sc.example.com"), or null if it isn't a valid one. */
export function originOf(url: string): string | null {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

/**
 * Build the effective allowlist from the configured entries plus, implicitly, the
 * primary URL's origin — SC's own address is always allowed to call SC, so nobody
 * has to notice that it would otherwise need listing.
 *
 * An entry of `*` anywhere keeps the wildcard. An empty result means the same:
 * unconfigured installs keep today's behaviour.
 */
export function resolveAllowedOrigins(configured: readonly string[], primaryUrl: string | null): string[] {
    const out: string[] = [];
    for (const entry of configured) {
        const trimmed = entry.trim();
        if (!trimmed) {
            continue;
        }
        // Accept a bare origin or a full URL, so "https://x/" and "https://x" agree.
        const normalized = trimmed === "*" ? "*" : originOf(trimmed);
        if (normalized && !out.includes(normalized)) {
            out.push(normalized);
        }
    }
    const primary = primaryUrl ? originOf(primaryUrl) : null;
    if (primary && !out.includes(primary)) {
        out.push(primary);
    }
    return out;
}

/**
 * The `Access-Control-*` headers for one request.
 *
 * With no allowlist (or an explicit `*`) this is the wildcard, as before. Otherwise
 * the request's own `Origin` is echoed back when it's listed — echoing rather than
 * returning the whole list is what the spec allows, since the header takes exactly
 * one origin — and omitted when it isn't, which is what makes the browser refuse.
 * `Vary: Origin` goes with it so a cache can't serve one origin's answer to another.
 */
export function corsHeaders(origin: string | null, allowed: readonly string[]): Record<string, string> {
    const base: Record<string, string> = {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (allowed.length === 0 || allowed.includes("*")) {
        return { ...base, "Access-Control-Allow-Origin": "*" };
    }
    base.Vary = "Origin";
    if (origin && allowed.includes(origin)) {
        base["Access-Control-Allow-Origin"] = origin;
    }
    return base;
}

/**
 * Host (`hostname[:port]`) of an origin or a `Host` header value, lowercased.
 * A `Host` header is bare authority with no scheme, so it's parsed against a
 * dummy one; anything that doesn't parse is null rather than a wildcard match.
 */
function hostOf(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    try {
        return new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`).host.toLowerCase();
    } catch {
        return null;
    }
}

/**
 * Whether a state-changing request may be *acted on*, judged by its `Origin`.
 *
 * This is the request-level control the CORS headers above are not. A
 * cross-origin POST with `Content-Type: text/plain` is a "simple" request: no
 * preflight happens, and `req.json()` parses the body regardless of the declared
 * type — so any page a browser visits could otherwise reach an un-setup control
 * plane on the LAN and claim ownership through `setupOwner`. Browsers always
 * attach `Origin` to a cross-origin POST and page JS cannot forge it, so
 * comparing it here is enough to refuse exactly those requests.
 *
 * Allowed when:
 * - there is no `Origin` at all — curl, a script, another server. Nothing
 *   ambient to abuse there; the caller needs a token like anyone else.
 * - the origin's host is the host the request arrived on (`Host`, or an
 *   `X-Forwarded-Host` written by a front end). Scheme is deliberately not
 *   compared: a TLS-terminating proxy makes `Origin` https while the request
 *   arrives as http, and that pairing is the normal deployment, not an attack.
 * - the origin is listed in `allowedOrigins`, or that list is an explicit `*` —
 *   a deliberate opt-out for a cross-origin caller that wants the API open.
 *   An *empty* list is not that opt-out: unconfigured means same-origin only.
 *
 * Passing forwarded host values in unfiltered is safe even from an untrusted
 * peer: a browser can't set `X-Forwarded-Host` without turning the request into
 * a preflighted one, and the preflight's `Access-Control-Allow-Headers` doesn't
 * list it. A non-browser caller doesn't need the trick — it just omits `Origin`.
 */
export function originAllowsRequest(origin: string | null, hosts: readonly (string | null)[], allowed: readonly string[]): boolean {
    if (!origin) {
        return true;
    }
    if (allowed.includes("*") || allowed.includes(origin)) {
        return true;
    }
    const from = hostOf(origin);
    return from !== null && hosts.some((host) => host !== null && hostOf(host) === from);
}
