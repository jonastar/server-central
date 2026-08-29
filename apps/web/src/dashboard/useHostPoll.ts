import { useEffect, useState } from "react";
import type { CentralApiOperations } from "@central/shared";
import { api } from "../api";

/**
 * Shared polling cache for dashboard widgets.
 *
 * Every view in this app hand-rolls `useEffect` + `setInterval(10s)` (see
 * DockerOverview/DockerStacks). That's fine for one view at a time and wrong for
 * a page of eight cards: three stack cards on one host would be three identical
 * requests every ten seconds, and a forgotten background tab would poll a fleet
 * forever.
 *
 * So requests are keyed by `(operation, arguments)` and shared:
 *   - one in-flight request and one timer per key, however many widgets subscribe;
 *   - polling stops when the last subscriber unmounts (the value is kept, so a
 *     remount paints immediately and then refreshes);
 *   - polling stops while the tab is hidden, and fires once on the way back;
 *   - errors back off (10s → 20s → 40s → 60s) instead of hammering a host that
 *     is answering with a stack trace.
 *
 * `enabled: false` subscribes to nothing at all — that's how an offline host
 * costs zero requests rather than a page of failing ones.
 */

export const DEFAULT_POLL_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
/** How long an unsubscribed key keeps its value before being dropped. Long
 *  enough that tabbing between a host's sections repaints instantly, short
 *  enough that browsing a fleet doesn't accumulate a cache entry per host
 *  for the life of the page. */
const EVICT_AFTER_MS = 5 * 60_000;

export interface PollState<T> {
    data: T | null;
    error: string | null;
    /** True until the first result (or first error) for this key arrives. */
    loading: boolean;
    /** Force an immediate refetch — for a widget that just ran an action. */
    refresh(): void;
}

type Op = keyof CentralApiOperations;

interface Entry {
    op: Op;
    args: unknown;
    intervalMs: number;
    data: unknown;
    error: string | null;
    loading: boolean;
    /** Consecutive failures, for the backoff. */
    failures: number;
    inFlight: Promise<void> | null;
    timer: ReturnType<typeof setTimeout> | null;
    evictTimer: ReturnType<typeof setTimeout> | null;
    subscribers: Set<() => void>;
}

const entries = new Map<string, Entry>();

function keyOf(op: Op, args: unknown): string {
    return `${op}:${JSON.stringify(args ?? null)}`;
}

function notify(entry: Entry): void {
    for (const listener of entry.subscribers) {
        listener();
    }
}

function delayFor(entry: Entry): number {
    if (entry.failures === 0) {
        return entry.intervalMs;
    }
    return Math.min(MAX_BACKOFF_MS, entry.intervalMs * 2 ** Math.min(entry.failures, 5));
}

function schedule(entry: Entry): void {
    if (entry.timer) {
        clearTimeout(entry.timer);
    }
    entry.timer = null;
    // A hidden tab keeps no timer at all; `visibilitychange` refetches on the way
    // back. Checked here rather than only in the listener because a request that
    // was already in flight when the tab was hidden lands in `finally` and would
    // otherwise restart the clock behind everyone's back.
    if (entry.subscribers.size === 0 || (typeof document !== "undefined" && document.hidden)) {
        return;
    }
    entry.timer = setTimeout(() => void fetchNow(entry), delayFor(entry));
}

function fetchNow(entry: Entry): Promise<void> {
    if (entry.inFlight) {
        return entry.inFlight;
    }
    // A hidden tab still services an explicit refresh() or a first subscribe;
    // what it must not do is keep the timer running, which `schedule` handles
    // via the visibility listener below.
    const run = (async () => {
        try {
            // The cast is the same one `api` callers make everywhere: the key
            // pairs an op with its own args, so the pairing is correct by
            // construction even though this generic wrapper can't prove it.
            entry.data = await api(entry.op as never, entry.args as never);
            entry.error = null;
            entry.failures = 0;
        } catch (err) {
            entry.error = err instanceof Error ? err.message : String(err);
            entry.failures += 1;
        } finally {
            entry.loading = false;
            entry.inFlight = null;
            notify(entry);
            schedule(entry);
        }
    })();
    entry.inFlight = run;
    return run;
}

function getEntry(op: Op, args: unknown, intervalMs: number): Entry {
    const key = keyOf(op, args);
    let entry = entries.get(key);
    if (!entry) {
        entry = {
            op,
            args,
            intervalMs,
            data: null,
            error: null,
            loading: true,
            failures: 0,
            inFlight: null,
            timer: null,
            evictTimer: null,
            subscribers: new Set(),
        };
        entries.set(key, entry);
    }
    if (entry.evictTimer) {
        clearTimeout(entry.evictTimer);
        entry.evictTimer = null;
    }
    // Two widgets can want the same data at different cadences; the tighter one
    // wins, since it's the one that would otherwise be starved.
    entry.intervalMs = Math.min(entry.intervalMs, intervalMs);
    return entry;
}

if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
        for (const entry of entries.values()) {
            if (entry.subscribers.size === 0) {
                continue;
            }
            if (document.hidden) {
                // Stop the clock. The next `schedule` on return restarts it.
                if (entry.timer) {
                    clearTimeout(entry.timer);
                }
                entry.timer = null;
            } else {
                void fetchNow(entry);
            }
        }
    });
}

/**
 * Subscribe to a polled operation. Returns the shared cache entry's current
 * state, re-rendering when it changes.
 */
export function useHostPoll<K extends Op>(
    op: K,
    args: CentralApiOperations[K]["data"],
    opts: { enabled?: boolean; intervalMs?: number } = {},
): PollState<CentralApiOperations[K]["response"]> {
    const { enabled = true, intervalMs = DEFAULT_POLL_MS } = opts;
    // The key is the dependency: identical args from different renders must not
    // resubscribe, and changed args must.
    const key = enabled ? keyOf(op, args) : null;
    const [, bump] = useState(0);

    useEffect(() => {
        if (key === null) {
            return;
        }
        const entry = getEntry(op, args, intervalMs);
        const listener = () => bump((n) => n + 1);
        entry.subscribers.add(listener);
        if (entry.data === null && entry.error === null) {
            void fetchNow(entry);
        } else {
            schedule(entry);
        }
        return () => {
            entry.subscribers.delete(listener);
            if (entry.subscribers.size > 0) {
                return;
            }
            if (entry.timer) {
                clearTimeout(entry.timer);
                entry.timer = null;
            }
            // Keep the value briefly so a remount paints from cache, then drop
            // the whole entry — otherwise browsing N hosts leaks N entries.
            entry.evictTimer = setTimeout(() => {
                if (entry.subscribers.size === 0) {
                    entries.delete(keyOf(entry.op, entry.args));
                }
            }, EVICT_AFTER_MS);
        };
        // `key` already encodes op+args; intervalMs only ever tightens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    if (key === null) {
        return { data: null, error: null, loading: false, refresh: () => {} };
    }
    const entry = getEntry(op, args, intervalMs);
    return {
        data: entry.data as CentralApiOperations[K]["response"] | null,
        error: entry.error,
        loading: entry.loading,
        refresh: () => void fetchNow(entry),
    };
}
