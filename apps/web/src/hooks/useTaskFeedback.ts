import { useEffect, useState } from "react";
import { taskFeedbackManager, type TaskFeedbackState } from "../taskFeedback";

export function useTaskFeedback(): TaskFeedbackState {
    const [state, setState] = useState<TaskFeedbackState>(() => taskFeedbackManager.getState());

    useEffect(() => {
        const id = taskFeedbackManager.addListener(setState);
        return () => taskFeedbackManager.removeListener(id);
    }, []);

    return state;
}
