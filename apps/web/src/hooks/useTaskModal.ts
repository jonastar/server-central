import { useEffect, useState } from "react";
import { taskModalManager, type TaskModalState } from "../taskModal";

export function useTaskModal(): TaskModalState {
    const [state, setState] = useState<TaskModalState>(() => taskModalManager.getState());

    useEffect(() => {
        const id = taskModalManager.addListener(setState);
        return () => taskModalManager.removeListener(id);
    }, []);

    return state;
}
