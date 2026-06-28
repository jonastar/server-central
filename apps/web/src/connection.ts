import type { ApiEvent, MetricsSnapshot, ServerEntry, TaskRun } from "@central/shared";
import { api, API_HOST, getToken } from "./api";

const METRICS_CLIENT_MAX = 720;

export type ConnectionState = {
    connected: boolean;
    connecting: boolean;
    servers: ServerEntry[];
    /** serverId → snapshots, oldest first. */
    metrics: Record<string, MetricsSnapshot[]>;
    /** Recent task runs, newest first. */
    tasks: TaskRun[];
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
        this.ws?.close();
        this.ws = null;
        this.update({ connected: false, connecting: true, servers: [], metrics: {}, tasks: [] });
    }

    private connect() {
        if (!this.running) {
            return;
        }
        const token = getToken();
        if (!token) {
            return;
        }
        const ws = new WebSocket(`ws://${API_HOST}/events?token=${encodeURIComponent(token)}`);
        this.ws = ws;
        ws.onopen = () => this.update({ connected: true, connecting: false });
        ws.onclose = () => {
            this.ws = null;
            if (!this.running) {
                return;
            }
            this.update({ connected: false, connecting: true });
            this.reconnectTimer = setTimeout(() => this.connect(), 3000);
        };
        ws.onerror = (err) => console.error("WebSocket error", err);
        ws.onmessage = (event) => this.handleEvent(JSON.parse(event.data) as ApiEvent);
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
        }
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
