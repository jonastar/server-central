import { useEffect, useState } from "react";

export function useLocalStorageState<T>(key: string, initial: T): [T, (v: T) => void] {
    const [value, setValue] = useState<T>(() => {
        try {
            const raw = localStorage.getItem(key);
            return raw == null ? initial : (JSON.parse(raw) as T);
        } catch {
            return initial;
        }
    });

    useEffect(() => {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch { /* quota or disabled */ }
    }, [key, value]);

    return [value, setValue];
}
