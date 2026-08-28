import type { ApiEvent, MetricsSnapshot, ServerEntry, TaskLogLine, TaskRun } from "@central/shared";
import { api, getToken, wsUrl } from "./api";
import { isTerminalStatus } from "./taskFormat";

const METRICS_CLIENT_MAX = 720;
/** Client-side mirror of the server's per-run log cap (TaskRunner.MAX_LOG_LINES). */
const TASK_LOG_CLIENT_MAX = 2000;
/** How often {@link ConnectionManager.waitForTask} falls back to asking, while
 *  the events socket is down and no `taskUpdate` can reach us. */
const TASK_WAIT_FALLBACK_POLL_MS = 3000;

export type ConnectionState = {
    connected: boolean;
    connecting: boolean;
    servers: ServerEntry[];
    /** serverId → snapshots, oldest first. */
    metrics: Record<string, MetricsSnapshot[]>;
    /** Recent task runs, newest first. */
    tasks: TaskRun[];
    /** taskId → log lines seen so far, oldest first. Only populated for runs a
     *  view has fetched or that logged while this page was connected. */
    taskLogs: Record<string, TaskLogLine[]>;
    conn: { sendCommand: typeof api };
};

class ConnectionManager {
    private lastListenerId = 0;
    private listeners: Map<number, (state: ConnectionState) => void> = new Map();
    private ws: WebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private running = false;

    private state: Omit<ConnectionState, "conn"> = {
        connected: false,
        connecting: true,
        servers: [],
        metrics: {},
        tasks: [],
        taskLogs: {},
    };

    /** Open the events socket. Called once the user is authenticated. */
    start() {
        if (this.running) {
            return;
        }
        this.running = true;
        this.connect();
    }

    /** Close the socket and reset state (on logout / auth loss). */
    stop() {
        this.running = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        this.reconnectTimer = null;
        if (this.ws) {
            // Strip handlers before closing: the close handshake is a network
            // round trip, not instant, and React StrictMode's dev-only double
            // mount/unmount calls stop() then start() back to back — without
            // this, the old socket's onmessage stays live and double-delivers
            // every broadcast (incl. taskLog) until its close actually lands.
            this.ws.onopen = null;
            this.ws.onclose = null;
            this.ws.onmessage = null;
            this.ws.onerror = null;
            this.ws.close();
        }
        this.ws = null;
        this.update({ connected: false, connecting: true, servers: [], metrics: {}, tasks: [], taskLogs: {} });
    }

    private connect() {
        if (!this.running) {
            return;
        }
        const token = getToken();
        if (!token) {
            return;
        }
        const ws = new WebSocket(wsUrl("/events", { token }));
        this.ws = ws;
        // Guard every handler against `this.ws` having moved on (belt-and-braces
        // alongside stop()'s handler-stripping above) so a stale socket can never
        // apply a stray event or clobber state a newer connection already set.
        ws.onopen = () => {
            if (this.ws !== ws) {
                return;
            }
            this.update({ connected: true, connecting: false });
        };
        ws.onclose = () => {
            if (this.ws !== ws) {
                return;
            }
            this.ws = null;
            if (!this.running) {
                return;
            }
            this.update({ connected: false, connecting: true });
            this.reconnectTimer = setTimeout(() => this.connect(), 3000);
        };
        ws.onerror = (err) => console.error("WebSocket error", err);
        ws.onmessage = (event) => {
            if (this.ws !== ws) {
                return;
            }
            this.handleEvent(JSON.parse(event.data) as ApiEvent);
        };
    }

    private handleEvent(event: ApiEvent): void {
        switch (event.kind) {
            case "init":
                this.update({ servers: event.data.servers, metrics: event.data.metricsHistory, tasks: event.data.tasks });
                break;
            case "serversUpdate":
                this.update({ servers: event.data });
                break;
            case "statusUpdate": {
                const servers = this.state.servers.map((s) =>
                    s.id === event.data.serverId ? { ...s, status: event.data } : s,
                );
                this.update({ servers });
                break;
            }
            case "metrics": {
                const { serverId, snapshot } = event.data;
                const history = [...(this.state.metrics[serverId] ?? []), snapshot].slice(-METRICS_CLIENT_MAX);
                this.update({ metrics: { ...this.state.metrics, [serverId]: history } });
                break;
            }
            case "taskUpdate": {
                const run = event.data;
                const rest = this.state.tasks.filter((t) => t.id !== run.id);
                this.update({ tasks: [run, ...rest] });
                break;
            }
            case "taskLog": {
                const { taskId, lines } = event.data;
                const existing = this.state.taskLogs[taskId] ?? [];
                const merged = [...existing, ...lines].slice(-TASK_LOG_CLIENT_MAX);
                this.update({ taskLogs: { ...this.state.taskLogs, [taskId]: merged } });
                break;
            }
        }
    }

    /**
     * Resolve once a run reaches a terminal status.
     *
     * Driven by the `taskUpdate` events this socket already receives, so a call
     * site waiting on a run costs no requests at all — the same events that keep
     * TasksView and the task modal live. The slow poll below is a fallback for
     * exactly one case: the socket being down, which is also the only time no
     * event can arrive on its own.
     */
    waitForTask(id: string): Promise<TaskRun> {
        return new Promise((resolve) => {
            let listenerId: number | null = null;
            let timer: ReturnType<typeof setInterval> | null = null;
            let done = false;

            const finish = (run: TaskRun) => {
                done = true;
                if (listenerId !== null) {
                    this.removeListener(listenerId);
                }
                if (timer) {
                    clearInterval(timer);
                }
                resolve(run);
            };

            const check = (tasks: TaskRun[]): void => {
                if (done) {
                    return;
                }
                const run = tasks.find((t) => t.id === id);
                if (run && isTerminalStatus(run.status)) {
                    finish(run);
                }
            };

            // addListener fires synchronously, so an already-finished run resolves
            // here — before there's a listener id to remove, hence the `done` flag
            // and the cleanup right after.
            listenerId = this.addListener((state) => check(state.tasks));
            if (done) {
                this.removeListener(listenerId);
                return;
            }

            timer = setInterval(() => {
                if (this.state.connected) {
                    return;
                }
                void api("getTask", { id }).then(
                    (run) => { if (run) { check([run]); } },
                    () => { /* retried on the next tick */ },
                );
            }, TASK_WAIT_FALLBACK_POLL_MS);
        });
    }

    /**
     * Seed a run's log buffer from a `getTaskLogs` fetch (called by a view when
     * it first shows a run's logs). No-ops if lines have already arrived live —
     * the live stream is authoritative once it starts.
     */
    seedTaskLogs(taskId: string, lines: TaskLogLine[]): void {
        if (this.state.taskLogs[taskId] !== undefined) {
            return;
        }
        this.update({ taskLogs: { ...this.state.taskLogs, [taskId]: lines } });
    }

    private update(patch: Partial<Omit<ConnectionState, "conn">>): void {
        this.state = { ...this.state, ...patch };
        for (const l of this.listeners.values()) {
            l(this.getState());
        }
    }

    getState(): ConnectionState {
        return { ...this.state, conn: { sendCommand: api } };
    }

    addListener(listener: (s: ConnectionState) => void): number {
        const id = this.lastListenerId++;
        this.listeners.set(id, listener);
        listener(this.getState());
        return id;
    }

    removeListener(id: number): void {
        this.listeners.delete(id);
    }
}

export const connectionManager = new ConnectionManager();
