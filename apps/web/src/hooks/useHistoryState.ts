import { useCallback, useEffect, useRef, useState } from "react";

/** Where embedded-view state is parked on `history.state`, keyed by view. */
const NS = "__embedded";

type Bag = Record<string, unknown>;

function bagOf(state: unknown): Bag | undefined {
    const bag = (state as Record<string, unknown> | null | undefined)?.[NS];
    return typeof bag === "object" && bag !== null ? bag as Bag : undefined;
}

/**
 * Local state that also lands on the browser's history stack, without touching
 * the URL.
 *
 * Views embedded in an already-routed page — the file browser inside a stack's
 * Files tab or a container's Volumes tab — navigate on their own with nothing
 * of their own to put in the hash. Without this they are invisible to Back:
 * clicking three folders deep and hitting Back left the page entirely instead
 * of stepping back up one folder.
 *
 * Each write pushes a history entry carrying the value under `key`, so Back and
 * Forward walk the view's own trail. The current entry is also what the hook
 * initializes from, so the view comes back on the folder it was left on when
 * the surrounding tab remounts it (Back across a hash change fires `popstate`
 * before the route puts the view back on screen).
 *
 * `key` must be unique per live view *and* identify what is being browsed
 * (include the stack/container id) — a shared key would restore one view's
 * folder into another's.
 */
export function useHistoryState<T>(key: string, initial: T): [T, (next: T) => void] {
    const [value, setValue] = useState<T>(() => {
        const bag = bagOf(history.state);
        return bag && key in bag ? bag[key] as T : initial;
    });
    // Back past the entry this view opened on carries no value for it: fall
    // back to where it started rather than stranding the last folder on screen.
    const initialRef = useRef(initial);
    const keyRef = useRef(key);
    keyRef.current = key;

    useEffect(() => {
        const onPop = (e: PopStateEvent) => {
            const bag = bagOf(e.state);
            setValue(bag && keyRef.current in bag ? bag[keyRef.current] as T : initialRef.current);
        };
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, []);

    const push = useCallback((next: T) => {
        const bag = bagOf(history.state);
        // A write that changes nothing (re-opening the folder already shown)
        // must not push an entry — Back would then need pressing twice.
        if (bag && JSON.stringify(bag[keyRef.current]) === JSON.stringify(next)) {
            setValue(next);
            return;
        }
        history.pushState({ ...(history.state as object | null), [NS]: { ...bag, [keyRef.current]: next } }, "");
        setValue(next);
    }, []);

    return [value, push];
}
