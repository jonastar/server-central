import { useCallback, useEffect, useState } from "react";
import type { UserInfo } from "@central/shared";
import { api, clearToken, setToken, setUnauthorizedHandler } from "../api";

export type AuthState = {
    loading: boolean;
    needsSetup: boolean;
    user: UserInfo | null;
};

export type Auth = AuthState & {
    login: (username: string, password: string) => Promise<void>;
    setup: (username: string, password: string) => Promise<void>;
    logout: () => Promise<void>;
};

export function useAuth(): Auth {
    const [state, setState] = useState<AuthState>({ loading: true, needsSetup: false, user: null });

    const refresh = useCallback(async () => {
        try {
            const res = await api("getAuthState", undefined);
            setState({ loading: false, needsSetup: res.needsSetup, user: res.user });
        } catch {
            setState({ loading: false, needsSetup: false, user: null });
        }
    }, []);

    useEffect(() => {
        // A 401 mid-session drops us straight back to the login screen.
        setUnauthorizedHandler(() => setState((s) => ({ ...s, user: null })));
        void refresh();
        return () => setUnauthorizedHandler(null);
    }, [refresh]);

    const login = useCallback(async (username: string, password: string) => {
        const res = await api("login", { username, password });
        setToken(res.token);
        setState({ loading: false, needsSetup: false, user: res.user });
    }, []);

    const setup = useCallback(async (username: string, password: string) => {
        const res = await api("setupOwner", { username, password });
        setToken(res.token);
        setState({ loading: false, needsSetup: false, user: res.user });
    }, []);

    const logout = useCallback(async () => {
        try {
            await api("logout", undefined);
        } catch {
            /* best-effort; clear locally regardless */
        }
        clearToken();
        setState({ loading: false, needsSetup: false, user: null });
    }, []);

    return { ...state, login, setup, logout };
}
