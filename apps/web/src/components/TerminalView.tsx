import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalClientMessage, TerminalServerMessage } from "@central/shared";
import { API_HOST, getToken } from "../api";
import { copyToClipboard, cx } from "../utils";
import { markTerminalClosed, markTerminalOpened, terminalNeedsLeaveConfirm } from "../terminalSession";
import styles from "./TerminalView.module.css";
import shared from "../styles/shared.module.css";

export function TerminalView({ serverId, containerId }: { serverId: string; containerId?: string }) {
    const hostRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) {
            return;
        }

        markTerminalOpened();

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
        // Cell metrics taken before the monospace font finishes loading can be
        // slightly off (falls back to the system font), leaving the last row
        // clipped once the real font swaps in — refit once it's ready.
        void document.fonts?.ready?.then(() => fit.fit());

        const containerParam = containerId ? `&containerId=${encodeURIComponent(containerId)}` : "";
        const ws = new WebSocket(
            `ws://${API_HOST}/terminal?serverId=${encodeURIComponent(serverId)}&token=${encodeURIComponent(getToken() ?? "")}${containerParam}`,
        );
        const send = (msg: TerminalClientMessage) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(msg));
            }
        };

        // Ctrl+W is "delete word" in shell readline, but browsers treat it as a
        // reserved "close tab" shortcut and won't let a page override that — so
        // it never reaches the terminal. Ctrl+Backspace does the same delete
        // without colliding with a browser shortcut; bind it to the same
        // control byte (0x17 / ETB) that Ctrl+W would otherwise send.
        term.attachCustomKeyEventHandler((event) => {
            if (event.type !== "keydown") {
                return true;
            }
            if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key === "Backspace") {
                send({ type: "input", data: "\x17" });
                return false;
            }
            return true;
        });

        ws.onopen = () => send({ type: "resize", cols: term.cols, rows: term.rows });
        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data) as TerminalServerMessage;
            if (msg.type === "data") {
                term.write(msg.data);
            }
            else if (msg.type === "error") {
                term.writeln(`\r\n\x1b[31m${msg.message}\x1b[0m`);
            }
            else if (msg.type === "exit") {
                term.writeln("\r\n\x1b[90m[session ended]\x1b[0m");
            }
        };
        ws.onclose = () => term.writeln("\r\n\x1b[90m[disconnected]\x1b[0m");

        const dataSub = term.onData((data) => send({ type: "input", data }));
        const observer = new ResizeObserver(() => {
            fit.fit();
            send({ type: "resize", cols: term.cols, rows: term.rows });
        });
        observer.observe(host);
        term.focus();

        // Mirrors the "copy on select" convention of most desktop terminals so
        // Ctrl+C can stay reserved for SIGINT — highlighting text is enough to
        // put it on the clipboard, no separate copy shortcut needed.
        const onMouseUp = () => {
            if (term.hasSelection()) {
                void copyToClipboard(term.getSelection()).catch(() => {});
            }
        };
        host.addEventListener("mouseup", onMouseUp);

        // A closed tab/refresh has no in-app confirmation to hook into, so guard
        // it here: the session (and any unsaved terminal state) is lost the
        // instant this component unmounts. Skipped for the first few seconds
        // (see terminalSession.ts) so a quick accidental open+close doesn't nag.
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            if (terminalNeedsLeaveConfirm()) {
                e.preventDefault();
                e.returnValue = "";
            }
        };
        window.addEventListener("beforeunload", onBeforeUnload);

        return () => {
            markTerminalClosed();
            window.removeEventListener("beforeunload", onBeforeUnload);
            host.removeEventListener("mouseup", onMouseUp);
            observer.disconnect();
            dataSub.dispose();
            ws.close();
            term.dispose();
        };
    }, [serverId, containerId]);

    return (
        <div className={cx(shared.view, styles["terminal-view"])}>
            <div ref={hostRef} className={styles["terminal-host"]} />
        </div>
    );
}
