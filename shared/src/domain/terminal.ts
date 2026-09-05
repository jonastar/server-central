// ---- Terminal protocol (WebSocket at /terminal?serverId=...) --------------------

export type TerminalClientMessage =
    | { type: "input"; data: string }
    | { type: "resize"; cols: number; rows: number };

export type TerminalServerMessage =
    | { type: "data"; data: string }
    | { type: "exit"; code: number | null }
    | { type: "error"; message: string };
