import { useState } from "react";
import type { ServerEntry } from "@central/shared";
import { cx, hostCapability, hostCapabilityUnavailable, isAgentOutdated } from "../utils";
import { NAV_ITEMS, SERVER_TABS, type Route } from "../routes";
import { useCan } from "../hooks/usePermissions";
import { ExperimentalBadge, StatusDot } from "./ui";
import { AddNodeModal } from "./AddNodeModal";
import { BrandLockup } from "./Brand";
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
    const can = useCan();
    // Hidden, not greyed out. Greying is right for a host capability — that's
    // "this machine can't", which is information the operator wants. A section
    // someone will never be allowed into is just noise, and advertising it
    // invites them to ask why.
    const navItems = NAV_ITEMS.filter((item) => item.anyOf.some(can));
    const canSeeServers = can("panel.servers.read");

    return (
        <aside className={styles.sidebar}>
            {addingNode && <AddNodeModal servers={servers} onClose={() => setAddingNode(false)} />}
            <div className={styles["sidebar-brand"]} onClick={() => onNavigate({ view: "dashboard" })}>
                <BrandLockup height={20} />
            </div>

            {navItems.filter((item) => item.view !== "settings").map((item) => (
                <button
                    key={item.view}
                    className={cx(styles["nav-item"], route.view === item.view && styles.active)}
                    onClick={() => onNavigate({ view: item.view } as Route)}
                >
                    {item.label}
                    {item.view === "proxy" && <> <ExperimentalBadge compact /></>}
                    {item.view === "agents" && updatesAvailable && (
                        <span className={styles["nav-badge"]} title="An agent update is available">⚠</span>
                    )}
                </button>
            ))}

            {canSeeServers && (
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
            )}

            {canSeeServers && servers.length === 0 && (
                <div className={styles["sidebar-empty"]}>No agents connected.</div>
            )}

            {canSeeServers && servers.map((entry) => {
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
                                {SERVER_TABS.filter((tab) => can(tab.permission)).map((tab) => {
                                    const unavailable = hostCapabilityUnavailable(entry.status, tab.requires);
                                    const detail = tab.requires && hostCapability(entry.status, tab.requires)?.detail;
                                    return (
                                        <button
                                            key={tab.id}
                                            className={cx(
                                                styles["nav-item"],
                                                styles.sub,
                                                route.view === "server" && route.tab === tab.id && styles.active,
                                                unavailable && styles.unavailable,
                                            )}
                                            title={unavailable ? detail : undefined}
                                            onClick={() => onNavigate({ view: "server", serverId: entry.id, tab: tab.id })}
                                        >
                                            {tab.label} {tab.id === "zfs" && <ExperimentalBadge compact />}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                );
            })}

            <div className={styles["sidebar-footer"]}>
                {navItems.some((item) => item.view === "settings") && (
                    <button
                        className={cx(styles["nav-item"], route.view === "settings" && styles.active)}
                        onClick={() => onNavigate({ view: "settings" })}
                    >
                        Settings
                    </button>
                )}
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
