import type { CentralApiOperations } from "@central/shared";

/** Backend host — same machine that serves the UI, port 4141. */
export const API_HOST = `${location.hostname}:4141`;
const API_BASE = `http://${API_HOST}`;

export async function api<K extends keyof CentralApiOperations>(
    command: K,
    data: CentralApiOperations[K]["data"],
): Promise<CentralApiOperations[K]["response"]> {
    const res = await fetch(`${API_BASE}/${String(command)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data ?? null),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
    }

    const text = await res.text();
    return (text && text !== "null" ? JSON.parse(text) : undefined) as CentralApiOperations[K]["response"];
}
