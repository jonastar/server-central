import type { CentralApiOperations, TaskRun, TaskSpec } from "@central/shared";

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

/** Terminal statuses `runTaskAndWait` stops polling at. */
const TERMINAL: TaskRun["status"][] = ["succeeded", "failed", "cancelled"];

/**
 * Run a task and poll until it reaches a terminal status — for call sites that
 * want the old synchronous-await ergonomics (resolve with the finished run,
 * throw on failure/cancellation) while still getting task history + logs for
 * free. Not for kinds where "not ok" is itself a normal result (e.g.
 * `docker_image_pull`) — those resolve either way; check `run.result` instead.
 */
export async function runTaskAndWait(spec: TaskSpec, target: string | null, pollMs = 400): Promise<TaskRun> {
    const { id } = await api("runTask", { spec, target });
    for (;;) {
        const run = await api("getTask", { id });
        if (!run) {
            throw new Error("Task run disappeared");
        }
        if (TERMINAL.includes(run.status)) {
            if (run.status === "failed") {
                throw new Error(run.error ?? "Task failed");
            }
            if (run.status === "cancelled") {
                throw new Error("Task cancelled");
            }
            return run;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
}
