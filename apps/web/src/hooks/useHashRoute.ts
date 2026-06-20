import { useCallback, useEffect, useState } from "react";
import { type Route, hashToRoute, routeToHash } from "../routes";

/**
 * Route state backed by the URL hash, so the current view — including the file
 * browser's folder and open file — survives reloads and is shareable. Writing a
 * route updates `location.hash`, which fires `hashchange` and refreshes state.
 */
export function useHashRoute(): [Route, (route: Route) => void] {
    const [route, setRoute] = useState<Route>(() => hashToRoute(location.hash));

    useEffect(() => {
        const onHashChange = () => setRoute(hashToRoute(location.hash));
        window.addEventListener("hashchange", onHashChange);
        // Normalize an empty/garbage hash to the canonical dashboard hash once.
        if (!location.hash) {
            location.replace(routeToHash(route));
        }
        return () => window.removeEventListener("hashchange", onHashChange);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const navigate = useCallback((next: Route) => {
        const hash = routeToHash(next);
        if (hash === location.hash) {
            setRoute(next);
        }
        else {
            location.hash = hash; // fires hashchange → setRoute
        }
    }, []);

    return [route, navigate];
}
