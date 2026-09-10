import type { ApiNamespace, BinaryPart, CentralApiOperations, MultipartMeta } from "@central/shared";
import { API_PREFIX, MULTIPART_META_FIELD, isBinaryPart } from "@central/shared";

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
 * Port to send websockets to when the page did *not* come from the control plane.
 *
 * Normally it did, even in dev — the control plane serves the UI and forwards to
 * Vite for anything it doesn't own — so sockets are same-origin and this is null.
 * The exception is `bun run lab web`, where the dev server is the origin and the
 * control plane is the lab's, on another port. Vite can't proxy the upgrade
 * (see vite.config.ts), so the socket goes straight to the control plane.
 *
 * `VITE_API_PORT` is defined only in that mode, which is exactly the condition.
 */
const DEV_WS_PORT: string | null = import.meta.env.DEV && import.meta.env.VITE_API_PORT
    ? String(import.meta.env.VITE_API_PORT)
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
export interface ApiCallOptions {
    /**
     * Bytes sent so far, for a call carrying binary fields. `total` counts the
     * whole request body, so it's a little larger than the file itself — close
     * enough for a progress bar and honest about what's actually on the wire.
     */
    onProgress?(sent: number, total: number): void;
    /** Abort in flight. The only way to stop a large upload once it's started. */
    signal?: AbortSignal;
}

/** What both transports below reduce to, so the response handling is written once. */
interface RawResponse {
    status: number;
    ok: boolean;
    body: string;
}

/**
 * A call carrying binary fields, as `multipart/form-data`.
 *
 * The framing mirrors `MultipartMeta`: a JSON part naming every ordinary field
 * and declaring the binary ones, then one part per binary field in that order.
 * `FormData` preserves insertion order, which is what lets the server build the
 * whole payload from the first part and stream the rest into it.
 *
 * Two things here are deliberate. The `Blob` goes in untouched — the browser
 * streams a `File` off disk, so nothing reads the file into the tab. And no
 * `Content-Type` is set: only the browser knows the boundary it generated, and
 * setting the header by hand would strip it.
 */
function multipartBody(data: unknown, binaryFields: Array<[string, BinaryPart]>): FormData {
    const binaryNames = new Set(binaryFields.map(([name]) => name));
    const fields = Object.fromEntries(
        Object.entries(data as Record<string, unknown>).filter(([name]) => !binaryNames.has(name)),
    );
    const meta: MultipartMeta = {
        fields,
        binary: binaryFields.map(([name, part]) => ({ name, size: part.size, type: part.type ?? "" })),
    };

    const form = new FormData();
    form.set(MULTIPART_META_FIELD, JSON.stringify(meta));
    for (const [name, part] of binaryFields) {
        form.set(name, part as unknown as Blob);
    }
    return form;
}

/**
 * Send a body via XMLHttpRequest rather than fetch.
 *
 * The one reason: `fetch` reports no upload progress. A 200MB file otherwise
 * gives the user a spinner and no way to tell a slow transfer from a stuck one,
 * for however many minutes it takes. XHR's `upload.onprogress` is the only
 * browser API that answers that, so binary calls go through it.
 */
function xhrSend(url: string, token: string | null, form: FormData, opts: ApiCallOptions | undefined): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", url);
        if (token) {
            xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        }
        if (opts?.onProgress) {
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    opts.onProgress?.(event.loaded, event.total);
                }
            };
        }
        xhr.onload = () => resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, body: xhr.responseText });
        xhr.onerror = () => reject(new Error("Network error"));
        xhr.ontimeout = () => reject(new Error("Request timed out"));
        xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
        if (opts?.signal) {
            if (opts.signal.aborted) {
                reject(new DOMException("Upload cancelled", "AbortError"));
                return;
            }
            opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
        }
        xhr.send(form);
    });
}

export async function api<N extends ApiNamespace, O extends keyof CentralApiOperations[N]>(
    namespace: N,
    operation: O,
    data: CentralApiOperations[N][O] extends { data: infer D } ? D : never,
    opts?: ApiCallOptions,
): Promise<CentralApiOperations[N][O] extends { response: infer R } ? R : never> {
    const token = getToken();
    const url = `${API_BASE}/${String(namespace)}/${String(operation)}`;

    // The payload decides the framing, not the call site: an operation whose
    // type declares a `BinaryPart` field is handed a `File`, and that's enough
    // to know this call carries bytes. Top-level only — operation payloads are
    // flat, and a recursive walk would buy nothing but a way to be surprised.
    const binaryFields = (data && typeof data === "object" ? Object.entries(data) : [])
        .filter((entry): entry is [string, BinaryPart] => isBinaryPart(entry[1]));

    const res: RawResponse = binaryFields.length > 0
        ? await xhrSend(url, token, multipartBody(data, binaryFields), opts)
        : await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(data ?? null),
            signal: opts?.signal,
        }).then(async (r) => ({ status: r.status, ok: r.ok, body: await r.text() }));

    if (res.status === 401) {
        clearToken();
        onUnauthorized?.();
        throw new Error("Session expired — please sign in again");
    }
    if (!res.ok) {
        let error: string | undefined;
        try {
            error = (JSON.parse(res.body) as { error?: string }).error;
        } catch { /* not JSON — fall back to the status */ }
        throw new Error(error ?? `HTTP ${res.status}`);
    }

    return (res.body && res.body !== "null" ? JSON.parse(res.body) : undefined) as CentralApiOperations[N][O] extends { response: infer R } ? R : never;
}
