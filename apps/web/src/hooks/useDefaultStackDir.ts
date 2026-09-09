import { useEffect, useRef, useState } from "react";
import { FALLBACK_STACK_DIR } from "@central/shared";
import { api } from "../api";

/**
 * Base-directory state for the new/import stack dialogs, seeded from the host's
 * configured default once it arrives.
 *
 * The seed is deliberately conditional: the dialog renders immediately with the
 * built-in fallback so the field is never empty, and the fetched value is only
 * applied while the field is still untouched — otherwise a slow response would
 * overwrite a path someone had already started typing. `initial` short-circuits
 * the whole thing, for the adopt flow that opens with a directory it already
 * knows.
 */
export function useDefaultStackDir(hostId: string, initial?: string): [string, (dir: string) => void] {
    const [dir, setDirState] = useState(initial ?? FALLBACK_STACK_DIR);
    const touched = useRef(initial !== undefined);

    useEffect(() => {
        if (touched.current) {
            return;
        }
        let cancelled = false;
        api("compose", "getDefaultDir", { hostId })
            .then((res) => {
                if (!cancelled && !touched.current) {
                    setDirState(res.dir);
                }
            })
            .catch(() => { /* the fallback is already showing */ });
        return () => { cancelled = true; };
    }, [hostId]);

    return [dir, (next: string) => { touched.current = true; setDirState(next); }];
}
