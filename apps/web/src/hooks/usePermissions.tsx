import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Permission, UserInfo } from "@central/shared";
import { userCan } from "@central/shared";

const CurrentUserContext = createContext<UserInfo | null>(null);

/** Wraps the signed-in app so any view can ask what the current user may do
 *  without threading the user through every component in between. */
export function CurrentUserProvider({ user, children }: { user: UserInfo; children: ReactNode }) {
    return <CurrentUserContext.Provider value={user}>{children}</CurrentUserContext.Provider>;
}

export function useCurrentUser(): UserInfo | null {
    return useContext(CurrentUserContext);
}

/**
 * `can("panel.files.write")` for the signed-in user, using the same matcher the
 * server enforces with — including the rule that wildcards don't reach sensitive
 * nodes, so the UI can't offer a terminal the server would then refuse.
 *
 * This hides things the server would reject; it is not itself a security
 * boundary. Every one of these checks has a real counterpart in the dispatcher,
 * and that's the one that matters.
 */
export function useCan(): (permission: Permission) => boolean {
    const user = useCurrentUser();
    return useMemo(() => (permission: Permission) => userCan(user, permission), [user]);
}
