import type { CentralApiOperations } from "@central/shared";

/** Backend host — same machine that serves the UI, port 4141. */
export const API_HOST = `${location.hostname}:4141`;
const API_BASE = `http://${API_HOST}`;

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

export async function api<K extends keyof CentralApiOperations>(
    command: K,
    data: CentralApiOperations[K]["data"],
): Promise<CentralApiOperations[K]["response"]> {
    const token = getToken();
    const res = await fetch(`${API_BASE}/${String(command)}`, {
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
    return (text && text !== "null" ? JSON.parse(text) : undefined) as CentralApiOperations[K]["response"];
}
