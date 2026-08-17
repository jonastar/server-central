import { useState } from "react";
import type { ServerEntry } from "@central/shared";
import { cx, isAgentOutdated } from "../utils";
import { SERVER_TABS, type Route } from "../routes";
import { StatusDot } from "./ui";
import { AddNodeModal } from "./AddNodeModal";
import styles from "./Sidebar.module.css";
import shared from "../styles/shared.module.css";

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
        <aside className={styles.sidebar}>
            {addingNode && <AddNodeModal servers={servers} onClose={() => setAddingNode(false)} />}
            <div className={styles["sidebar-brand"]} onClick={() => onNavigate({ view: "dashboard" })}>
                <span className={styles["brand-mark"]}>⬡</span> Server Central
            </div>

            <button
                className={cx(styles["nav-item"], route.view === "dashboard" && styles.active)}
                onClick={() => onNavigate({ view: "dashboard" })}
            >
                Dashboard
            </button>

            <button
                className={cx(styles["nav-item"], route.view === "agents" && styles.active)}
                onClick={() => onNavigate({ view: "agents" })}
            >
                Agents
                {updatesAvailable && (
                    <span className={styles["nav-badge"]} title="An agent update is available">⚠</span>
                )}
            </button>

            <button
                className={cx(styles["nav-item"], (route.view === "apps" || route.view === "app") && styles.active)}
                onClick={() => onNavigate({ view: "apps" })}
            >
                Apps
            </button>

            <button
                className={cx(styles["nav-item"], route.view === "proxy" && styles.active)}
                onClick={() => onNavigate({ view: "proxy" })}
            >
                Proxy
            </button>

            <button
                className={cx(styles["nav-item"], route.view === "tasks" && styles.active)}
                onClick={() => onNavigate({ view: "tasks" })}
            >
                Tasks
            </button>

            <div className={styles["sidebar-section"]}>
                <span>Servers</span>
                <button
                    className={shared["btn-icon"]}
                    title="Add node"
                    onClick={() => setAddingNode(true)}
                    style={{ marginLeft: "auto", fontSize: 16, lineHeight: 1 }}
                >
                    +
                </button>
            </div>

            {servers.length === 0 && (
                <div className={styles["sidebar-empty"]}>No agents connected.</div>
            )}

            {servers.map((entry) => {
                const selected = route.view === "server" && route.serverId === entry.id;
                const ip = entry.status.info?.primaryIp ?? "—";
                return (
                    <div key={entry.id} className={cx(styles["server-block"], selected && styles.selected)}>
                        <button
                            className={styles["server-row"]}
                            onClick={() => onNavigate({ view: "server", serverId: entry.id, tab: selected && route.view === "server" ? route.tab : "overview" })}
                        >
                            <StatusDot state={entry.status.state} title={entry.status.error ?? entry.status.state} />
                            <span className={styles["server-row-main"]}>
                                <span className={styles["server-name"]}>{entry.name}</span>
                                <span className={styles["server-meta"]}>{ip}</span>
                            </span>
                        </button>
                        {selected && (
                            <div>
                                {SERVER_TABS.map((tab) => (
                                    <button
                                        key={tab.id}
                                        className={cx(styles["nav-item"], styles.sub, route.view === "server" && route.tab === tab.id && styles.active)}
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

            <div className={styles["sidebar-footer"]}>
                <button
                    className={cx(styles["nav-item"], route.view === "settings" && styles.active)}
                    onClick={() => onNavigate({ view: "settings" })}
                >
                    Settings
                </button>
                <button className={styles["nav-item"]} onClick={onLogout}>
                    Sign out
                </button>
                <div className={styles["sidebar-status"]}>
                    <StatusDot state={backendConnected ? "online" : "connecting"} />
                    {backendConnected ? "Backend connected" : "Connecting…"}
                </div>
            </div>
        </aside>
    );
}
