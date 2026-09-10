import { WEB_ASSETS } from "./web-assets.generated";

// Whether the SPA was embedded at build time. Empty in dev (Vite serves the UI),
// populated by scripts/gen-web-assets.ts in release builds.
export const HAS_EMBEDDED_WEB = Object.keys(WEB_ASSETS).length > 0;

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
};

function contentType(route: string): string | undefined {
    const dot = route.lastIndexOf(".");
    return dot === -1 ? undefined : MIME[route.slice(dot).toLowerCase()];
}

function serve(route: string): Response {
    const headers: Record<string, string> = {};
    const type = contentType(route);
    if (type) {
        headers["Content-Type"] = type;
    }
    // Hashed assets are immutable; index.html must always be revalidated.
    headers["Cache-Control"] = route.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache";
    return new Response(Bun.file(WEB_ASSETS[route]), { headers });
}

/**
 * Serve an embedded SPA file for a GET request, or `null` when nothing is embedded
 * (dev) so the caller can fall through to its normal handling. Unknown paths without
 * a file extension fall back to index.html for client-side routing.
 */
/**
 * Where the UI comes from when it isn't embedded in this binary: the Vite dev
 * server.
 *
 * This is what makes dev and production the same shape. In a release build the
 * control plane is the only origin — API, OIDC endpoints, websockets and the SPA
 * all on one port. Dev used to invert that: Vite was the origin you opened, and
 * it forwarded a hand-maintained list of paths back to the control plane. That
 * list is unmaintainable by construction, because there is no rule on Vite's
 * side that separates them: `/oidc/authorize` is a page the SPA renders, while
 * `/oidc/token` is a server endpoint, and only the control plane knows which is
 * which. Two endpoints were in fact missed for months.
 *
 * Inverted, the rule is the one production already uses and needs no list: the
 * control plane serves what it owns, and everything else is the UI.
 */
/** Whether UI requests go to a dev server rather than to embedded assets: when
 *  nothing is embedded (a source checkout), or when someone said so explicitly. */
export function usingDevUi(): boolean {
    return !HAS_EMBEDDED_WEB || Boolean(process.env.SC_DEV_UI_ORIGIN);
}

function devUiOrigin(): string {
    return process.env.SC_DEV_UI_ORIGIN
        || `http://127.0.0.1:${process.env.SC_DEV_UI_PORT || 5151}`;
}

/** Headers that describe *this* hop and must not be replayed onto the next. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "content-encoding"]);

/**
 * Forward a UI request to the dev server.
 *
 * Only GET/HEAD, matching what {@link serveStatic} answers in a release build —
 * a dev server has nothing else to say, and keeping the two symmetric is the
 * whole point of this file.
 */
export async function serveDevUi(req: Request): Promise<Response> {
    const target = new URL(req.url);
    const origin = new URL(devUiOrigin());
    target.protocol = origin.protocol;
    target.host = origin.host;

    const headers = new Headers(req.headers);
    // Vite refuses hosts it wasn't configured for, and the browser's Host here
    // is whatever the control plane was reached as — a tailnet name, a proxied
    // domain. Presenting the dev server's own host keeps that from mattering.
    headers.set("host", origin.host);
    // Ask for it uncompressed, and say so explicitly: deleting the header is not
    // enough, because fetch then supplies its own `gzip, deflate, br, zstd`.
    // Without this the dev server compresses, fetch transparently decompresses,
    // and `content-encoding: gzip` rides along onto a body that is no longer
    // gzipped — so the browser tries to gunzip plain text. Stripping the header
    // on the way out (HOP_BY_HOP) covers the same hazard from the other side.
    headers.set("accept-encoding", "identity");

    let upstream: Response;
    try {
        upstream = await fetch(target, { method: req.method, headers, redirect: "manual" });
    } catch {
        return new Response(
            [
                `The UI dev server isn't running at ${devUiOrigin()}.`,
                "",
                "Start it with `bun run dev:web`, or run both halves with `bun run dev`.",
                "In a release build the SPA is embedded and this proxy is never used.",
                "",
            ].join("\n"),
            { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } },
        );
    }
    const out = new Headers();
    for (const [key, value] of upstream.headers) {
        if (!HOP_BY_HOP.has(key.toLowerCase())) {
            out.set(key, value);
        }
    }
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

export function serveStatic(pathname: string): Response | null {
    if (!HAS_EMBEDDED_WEB) {
        return null;
    }
    const route = pathname === "/" ? "/" : pathname;
    if (WEB_ASSETS[route]) {
        return serve(route);
    }
    // A missing path that looks like a file (has an extension) is a real 404;
    // anything else is a client route → hand back the SPA shell.
    if (route.includes(".") && !route.endsWith("/")) {
        return new Response("Not found", { status: 404 });
    }
    return serve("/");
}
