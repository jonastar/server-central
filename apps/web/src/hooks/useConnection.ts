import { useEffect, useState } from "react";
import { connectionManager, type ConnectionState } from "../connection";

export function useConnection(): ConnectionState {
    const [state, setState] = useState<ConnectionState>(() => connectionManager.getState());

    useEffect(() => {
        const id = connectionManager.addListener(setState);
        return () => connectionManager.removeListener(id);
    }, []);

    return state;
}
