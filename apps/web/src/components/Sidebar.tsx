import { useState } from "react";
import type { ServerEntry } from "@central/shared";
import { cx, isAgentOutdated } from "../utils";
import { SERVER_TABS, type Route } from "../routes";
import { StatusDot } from "./ui";
import { AddNodeModal } from "./AddNodeModal";

export function Sidebar({ servers, route, backendConnected, onNavigate, onLogout }: {
    servers: ServerEntry[];
    route: Route;
    backendConnected: boolean;
    onNavigate: (route: Route) => void;
    onLogout: () => void;
}) {
    const [addingNode, setAddingNode] = useState(false);
    const updatesAvailable = servers.some(isAgentOutdated);

    return (
        <aside className="sidebar">
            {addingNode && <AddNodeModal servers={servers} onClose={() => setAddingNode(false)} />}
            <div className="sidebar-brand" onClick={() => onNavigate({ view: "dashboard" })}>
                <span className="brand-mark">⬡</span> Server Central
            </div>

            <button
                className={cx("nav-item", route.view === "dashboard" && "active")}
                onClick={() => onNavigate({ view: "dashboard" })}
            >
                Dashboard
            </button>

            <button
                className={cx("nav-item", route.view === "agents" && "active")}
                onClick={() => onNavigate({ view: "agents" })}
            >
                Agents
                {updatesAvailable && (
                    <span className="nav-badge" title="An agent update is available">⚠</span>
                )}
            </button>

            <div className="sidebar-section">
                <span>Servers</span>
                <button
                    className="btn-icon"
                    title="Add node"
                    onClick={() => setAddingNode(true)}
                    style={{ marginLeft: "auto", fontSize: 16, lineHeight: 1 }}
                >
                    +
                </button>
            </div>

            {servers.length === 0 && (
                <div className="sidebar-empty">No agents connected.</div>
            )}

            {servers.map((entry) => {
                const selected = route.view === "server" && route.serverId === entry.id;
                const ip = entry.status.info?.primaryIp ?? "—";
                return (
                    <div key={entry.id} className={cx("server-block", selected && "selected")}>
                        <button
                            className="server-row"
                            onClick={() => onNavigate({ view: "server", serverId: entry.id, tab: selected && route.view === "server" ? route.tab : "overview" })}
                        >
                            <StatusDot state={entry.status.state} title={entry.status.error ?? entry.status.state} />
                            <span className="server-row-main">
                                <span className="server-name">{entry.name}</span>
                                <span className="server-meta">{ip}</span>
                            </span>
                        </button>
                        {selected && (
                            <div className="server-tabs">
                                {SERVER_TABS.map((tab) => (
                                    <button
                                        key={tab.id}
                                        className={cx("nav-item sub", route.view === "server" && route.tab === tab.id && "active")}
                                        onClick={() => onNavigate({ view: "server", serverId: entry.id, tab: tab.id })}
                                    >
                                        {tab.label}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}

            <div className="sidebar-footer">
                <button
                    className={cx("nav-item", route.view === "settings" && "active")}
                    onClick={() => onNavigate({ view: "settings" })}
                    style={{ marginBottom: 8 }}
                >
                    Settings
                </button>
                <button className="nav-item" onClick={onLogout} style={{ marginBottom: 8 }}>
                    Sign out
                </button>
                <StatusDot state={backendConnected ? "online" : "connecting"} />
                {backendConnected ? "Backend connected" : "Connecting…"}
            </div>
        </aside>
    );
}
