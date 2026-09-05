import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { ApiEvent, TerminalClientMessage, TerminalServerMessage, UserInfo } from "@central/shared";
import { eventPermission, userCan } from "@central/shared";
import type { Fleet } from "../fleet";
import type { ShellSession } from "../host-agent";
import type { TaskStore } from "../tasks/store";
import { openTerminalShell } from "../features/terminal/feature";

// ---- The two WebSocket channels -------------------------------------------------
//
// `/events` is the push side of the pull API: every socket carries the same
// payloads `getServers`/`listTasks` return, so it's filtered by the same
// permissions. `/terminal` is a PTY bridge — a byte pipe, not an event stream.
//
// Both live here rather than in the composition root because the connection
// lifecycle (upgrade data, open/message/close) is the interesting part and it's
// the same shape for both; index.ts keeps only the `Bun.serve` call that mounts
// them.

export type WsData =
    // The user rides along so pushed events can be filtered the same way pulled
    // ones are: this socket carries fleet inventory and task history, which are
    // exactly the `getServers`/`listTasks` payloads by another route. Resolved at
    // upgrade and not refreshed, so a permission change takes effect on the
    // client's next reconnect rather than mid-stream.
    | { channel: "events"; user: UserInfo }
    // containerId, when set, opens a terminal into that container (`docker exec
    // -it`) instead of a host shell.
    | { channel: "terminal"; serverId: string; containerId: string | null; user: UserInfo; shell: ShellSession | null };

/**
 * The `/events` fan-out plus the two socket handlers that feed it.
 *
 * Owns the socket set, so nothing outside can hold a stale reference to a closed
 * connection — `broadcast` is the only way in.
 */
export class EventHub {
    private readonly sockets = new Set<ServerWebSocket<WsData>>();

    constructor(
        private readonly fleet: Fleet,
        private readonly tasks: TaskStore,
    ) { }

    /** Push an event to every socket whose user may see it. */
    broadcast = (event: ApiEvent): void => {
        const payload = JSON.stringify(event);
        const required = eventPermission(event.kind);
        for (const socket of this.sockets) {
            if (!userCan(socket.data.user, required)) {
                continue;
            }
            socket.send(payload);
        }
    };

    /** The initial state snapshot a socket gets on connect.
     *
     *  Same filter as `broadcast`, applied to the snapshot. The two halves are
     *  independent permissions on purpose: reading task history and reading the
     *  fleet are separate grants everywhere else, and this is the one place
     *  they'd otherwise be bundled. */
    private initEvent(user: UserInfo): ApiEvent {
        const canSeeServers = userCan(user, "panel.servers.read");
        return {
            kind: "init",
            data: {
                servers: canSeeServers ? this.fleet.entries() : [],
                metricsHistory: canSeeServers ? this.fleet.metricsHistory() : {},
                tasks: userCan(user, "panel.tasks.read") ? this.tasks.list() : [],
            },
        };
    }

    handler(): WebSocketHandler<WsData> {
        return {
            open: (ws) => {
                if (ws.data.channel === "events") {
                    this.sockets.add(ws);
                    ws.send(JSON.stringify(this.initEvent(ws.data.user)));
                } else {
                    void openTerminal(this.fleet, ws);
                }
            },
            message: (ws, message) => {
                if (ws.data.channel !== "terminal" || !ws.data.shell) {
                    return;
                }
                try {
                    const msg = JSON.parse(String(message)) as TerminalClientMessage;
                    if (msg.type === "input") {
                        ws.data.shell.write(msg.data);
                    }
                    else if (msg.type === "resize") {
                        ws.data.shell.resize(msg.cols, msg.rows);
                    }
                } catch { /* ignore malformed frames */ }
            },
            close: (ws) => {
                if (ws.data.channel === "events") {
                    this.sockets.delete(ws);
                }
                else {
                    ws.data.shell?.close();
                }
            },
        };
    }
}

function sendTerminal(ws: ServerWebSocket<WsData>, msg: TerminalServerMessage): void {
    ws.send(JSON.stringify(msg));
}

async function openTerminal(fleet: Fleet, ws: ServerWebSocket<WsData>): Promise<void> {
    if (ws.data.channel !== "terminal") {
        return;
    }
    try {
        const shell = await openTerminalShell(fleet, ws.data.serverId, ws.data.containerId, ws.data.user);
        ws.data.shell = shell;
        shell.onData((data) => sendTerminal(ws, { type: "data", data }));
        shell.onExit((code) => {
            sendTerminal(ws, { type: "exit", code });
            ws.close();
        });
    } catch (err) {
        sendTerminal(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
        ws.close();
    }
}
