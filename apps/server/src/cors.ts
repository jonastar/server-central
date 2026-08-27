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
 * whatever this says. Narrowing it is tidiness and defence in depth, not a
 * request-level control; see the note in next.md.
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
