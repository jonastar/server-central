import type { ApiEvent, MetricsSnapshot, ServerEntry, TaskLogLine, TaskRun } from "@central/shared";
import { api, getToken, wsUrl } from "./api";

const METRICS_CLIENT_MAX = 720;
/** Client-side mirror of the server's per-run log cap (TaskRunner.MAX_LOG_LINES). */
const TASK_LOG_CLIENT_MAX = 2000;

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
