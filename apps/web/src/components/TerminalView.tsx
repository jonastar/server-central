import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalClientMessage, TerminalServerMessage } from "@central/shared";
import { API_HOST } from "../api";

export function TerminalView({ serverId }: { serverId: string }) {
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        const term = new Terminal({
            fontSize: 13,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            cursorBlink: true,
            theme: { background: "#1d2026", foreground: "#d6d9de" },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(host);
        fit.fit();

        const ws = new WebSocket(`ws://${API_HOST}/terminal?serverId=${encodeURIComponent(serverId)}`);
        const send = (msg: TerminalClientMessage) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
        };

        ws.onopen = () => send({ type: "resize", cols: term.cols, rows: term.rows });
        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data) as TerminalServerMessage;
            if (msg.type === "data") term.write(msg.data);
            else if (msg.type === "error") term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`);
            else if (msg.type === "exit") term.writeln("\r\n\x1b[90m[session ended]\x1b[0m");
        };
        ws.onclose = () => term.writeln("\r\n\x1b[90m[disconnected]\x1b[0m");

        const dataSub = term.onData((data) => send({ type: "input", data }));
        const observer = new ResizeObserver(() => {
            fit.fit();
            send({ type: "resize", cols: term.cols, rows: term.rows });
        });
        observer.observe(host);
        term.focus();

        return () => {
            observer.disconnect();
            dataSub.dispose();
            ws.close();
            term.dispose();
        };
    }, [serverId]);

    return (
        <div className="view terminal-view">
            <div ref={hostRef} className="terminal-host" />
        </div>
    );
}
