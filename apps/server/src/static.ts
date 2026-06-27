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
