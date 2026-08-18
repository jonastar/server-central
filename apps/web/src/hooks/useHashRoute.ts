import { useCallback, useEffect, useRef, useState } from "react";
import { type Route, hashToRoute, routeToHash } from "../routes";

/**
 * Route state backed by the URL hash, so the current view — including the file
 * browser's folder and open file — survives reloads and is shareable. Writing a
 * route updates `location.hash`, which fires `hashchange` and refreshes state.
 *
 * `guard`, if given, is asked before any navigation away from the current
 * route (including back/forward and manual hash edits) and can veto it —
 * e.g. confirming before a route change silently drops a terminal session.
 */
export function useHashRoute(guard?: (from: Route, to: Route) => boolean): [Route, (route: Route) => void] {
    const [route, setRoute] = useState<Route>(() => hashToRoute(location.hash));
    const routeRef = useRef(route);
    routeRef.current = route;
    const guardRef = useRef(guard);
    guardRef.current = guard;
    // A hash `navigate()` just set after its own guard check already approved
    // it — `onHashChange` still fires for that write, so it needs a way to
    // tell "already asked" apart from an external change (back/forward,
    // manual edit) that hasn't been guarded yet. Without this, a guarded
    // in-app navigation asked twice: once in `navigate()`, once again when
    // the resulting `hashchange` event reached this handler.
    const pendingHashRef = useRef<string | null>(null);

    useEffect(() => {
        const onHashChange = () => {
            const next = hashToRoute(location.hash);
            if (pendingHashRef.current === location.hash) {
                pendingHashRef.current = null;
                setRoute(next);
                return;
            }
            if (guardRef.current && !guardRef.current(routeRef.current, next)) {
                // Veto: the hash already changed (back/forward already moved it),
                // so put it back rather than adopting the declined route.
                location.hash = routeToHash(routeRef.current);
                return;
            }
            setRoute(next);
        };
        window.addEventListener("hashchange", onHashChange);
        // Normalize an empty/garbage hash to the canonical dashboard hash once.
        if (!location.hash) {
            location.replace(routeToHash(route));
        }
        return () => window.removeEventListener("hashchange", onHashChange);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const navigate = useCallback((next: Route) => {
        if (guardRef.current && !guardRef.current(routeRef.current, next)) {
            return;
        }
        const hash = routeToHash(next);
        if (hash === location.hash) {
            setRoute(next);
        }
        else {
            pendingHashRef.current = hash;
            location.hash = hash; // fires hashchange → setRoute
        }
    }, []);

    return [route, navigate];
}
