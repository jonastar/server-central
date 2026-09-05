import type { ApiNamespace, CentralApiOperations } from "@central/shared";
import { API_PREFIX } from "@central/shared";

/**
 * Every request goes to the page's own origin, under {@link API_PREFIX}.
 *
 * Nothing here names a scheme, host or port. That's what lets the control plane
 * sit behind a TLS-terminating reverse proxy: served from
 * `https://sc.example.com/`, the UI calls `https://sc.example.com/api/...` and
 * the websockets below come out `wss:`, with no configuration to keep in sync.
 * Hardcoding `http://host:4141` — as this did — instead produced a mixed-content
 * block on the first call.
 *
 * In dev the UI is served by Vite on another port; it proxies `/api` back to the
 * control plane (see apps/web/vite.config.ts), so these same relative paths work
 * there too.
 */
const API_BASE = API_PREFIX;

/**
 * Port to send websockets to in dev, or null in a release build (where they go to
 * the page's own origin, like everything else).
 *
 * HTTP goes through the Vite dev server's `/api` proxy, but websockets can't: Vite
 * 5 proxies through `http-proxy`, whose upgrade handling doesn't work under Bun.
 * The upgrade reaches the control plane and it answers 101, but the response never
 * makes it back to the browser — writes to the socket Node's `upgrade` event hands
 * over report success and deliver nothing — so the socket sits in CONNECTING and
 * the UI reads "connecting" forever. Handling the upgrade in a custom plugin hits
 * the same wall, so in dev the sockets skip the dev server and go straight to the
 * control plane. `VITE_API_PORT` points that at the e2e lab's control plane, the
 * same as it does for the proxy target.
 *
 * Only dev is affected. A release build is served by the control plane itself, so
 * there's one origin and nothing to bypass.
 */
const DEV_WS_PORT: string | null = import.meta.env.DEV
    ? String(import.meta.env.VITE_API_PORT ?? 4141)
    : null;

/** `ws:`/`wss:` matching the page — a proxied (https) UI needs a secure socket. */
export function wsUrl(path: string, params: Record<string, string>): string {
    const url = new URL(`${API_PREFIX}${path}`, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    if (DEV_WS_PORT) {
        url.port = DEV_WS_PORT;
    }
    for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
    }
    return url.toString();
}

const TOKEN_KEY = "sc-auth-token";

export function getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
    localStorage.removeItem(TOKEN_KEY);
}

/** Notified when the server rejects our token (401) so the UI can show login. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
    onUnauthorized = fn;
}

/**
 * Call one operation: `api("docker", "list", { serverId })` → `POST /api/docker/list`.
 *
 * The namespace is a separate argument rather than part of one qualified string
 * so the two generics resolve independently — picking the namespace narrows the
 * operations the second argument accepts, and `data`/the return type follow from
 * both.
 */
export async function api<N extends ApiNamespace, O extends keyof CentralApiOperations[N]>(
    namespace: N,
    operation: O,
    data: CentralApiOperations[N][O] extends { data: infer D } ? D : never,
): Promise<CentralApiOperations[N][O] extends { response: infer R } ? R : never> {
    const token = getToken();
    const res = await fetch(`${API_BASE}/${String(namespace)}/${String(operation)}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(data ?? null),
    });

    if (res.status === 401) {
        clearToken();
        onUnauthorized?.();
        throw new Error("Session expired — please sign in again");
    }
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
    }

    const text = await res.text();
    return (text && text !== "null" ? JSON.parse(text) : undefined) as CentralApiOperations[N][O] extends { response: infer R } ? R : never;
}
