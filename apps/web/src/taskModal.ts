/** Which task run's live detail modal is open, if any — a module singleton
 *  (same shape as `connectionManager`) so any component can call `open(id)`
 *  to pop the modal without threading a callback down through props. */

export type TaskModalState = { openTaskId: string | null };

class TaskModalManager {
    private lastListenerId = 0;
    private listeners: Map<number, (state: TaskModalState) => void> = new Map();
    private state: TaskModalState = { openTaskId: null };

    open(taskId: string): void {
        this.update({ openTaskId: taskId });
    }

    close(): void {
        this.update({ openTaskId: null });
    }

    getState(): TaskModalState {
        return this.state;
    }

    addListener(listener: (s: TaskModalState) => void): number {
        const id = this.lastListenerId++;
        this.listeners.set(id, listener);
        listener(this.state);
        return id;
    }

    removeListener(id: number): void {
        this.listeners.delete(id);
    }

    private update(patch: Partial<TaskModalState>): void {
        this.state = { ...this.state, ...patch };
        for (const l of this.listeners.values()) {
            l(this.state);
        }
    }
}

export const taskModalManager = new TaskModalManager();
