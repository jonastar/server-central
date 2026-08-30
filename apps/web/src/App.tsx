import { useEffect } from "react";
import { useConnection } from "./hooks/useConnection";
import { useHashRoute } from "./hooks/useHashRoute";
import { leavesTerminalSession, NAV_ITEMS, SERVER_TABS, type Route } from "./routes";
import { CurrentUserProvider, useCan } from "./hooks/usePermissions";
import { hostCapability } from "./utils";
import { HostCapabilityNotice } from "./components/HostCapabilityNotice";
import { terminalNeedsLeaveConfirm } from "./terminalSession";
import { useAuth } from "./hooks/useAuth";
import { connectionManager } from "./connection";
import { LoginView } from "./components/LoginView";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { Dashboard } from "./components/Dashboard";
import { AgentsView } from "./components/AgentsView";
import { HostDashboard } from "./dashboard/HostDashboard";
import { FilesView } from "./components/FilesView";
import { DockerView } from "./components/DockerView";
import { ZfsView } from "./components/ZfsView";
import { MountsView } from "./components/MountsView";
import { ProcessesView } from "./components/ProcessesView";
import { NetworkView } from "./components/NetworkView";
import { ServicesView } from "./components/ServicesView";
import { SystemUsersView } from "./components/SystemUsersView";
import { TerminalView } from "./components/TerminalView";
import { ProxyView } from "./components/ProxyView";
import { TasksView } from "./components/TasksView";
import { TaskWidget } from "./components/TaskWidget";
import { TaskModal } from "./components/TaskModal";
import { SettingsView } from "./components/SettingsView";
import { EmptyState } from "./components/ui";
import styles from "./App.module.css";

function guardRouteChange(from: Route, to: Route): boolean {
    if (!leavesTerminalSession(from, to) || !terminalNeedsLeaveConfirm()) {
        return true;
    }
    return confirm("Leave the terminal? The current session will be closed.");
}

function AuthedApp({ onLogout }: { onLogout: () => void }) {
    const conn = useConnection();
    const can = useCan();
    const [route, setRoute] = useHashRoute(guardRouteChange);

    // The events socket only runs while a user is signed in.
    useEffect(() => {
        connectionManager.start();
        return () => connectionManager.stop();
    }, []);

    const currentEntry = route.view === "server"
        ? conn.servers.find((s) => s.id === route.serverId) ?? null
        : null;

    function renderMain() {
        // A hash is a URL: it survives bookmarks, reloads, and a permission being
        // taken away while a tab sits open. Checking here — rather than trusting
        // the sidebar to only ever offer reachable destinations — is what keeps a
        // stale link from rendering a view whose every request 403s.
        const nav = NAV_ITEMS.find((item) => item.view === route.view);
        if (nav && !nav.anyOf.some(can)) {
            return <EmptyState>You don't have access to this section.</EmptyState>;
        }
        if (route.view === "server") {
            const tabMeta = SERVER_TABS.find((t) => t.id === route.tab);
            if (tabMeta && !can(tabMeta.permission)) {
                return <EmptyState>You don't have access to this section.</EmptyState>;
            }
        }
        if (route.view === "dashboard") {
            return (
                <Dashboard
                    servers={conn.servers}
                    metrics={conn.metrics}
                    onOpenServer={(serverId) => setRoute({ view: "server", serverId, tab: "overview" })}
                />
            );
        }
        if (route.view === "agents") {
            return (
                <AgentsView
                    servers={conn.servers}
                    onOpenServer={(serverId) => setRoute({ view: "server", serverId, tab: "overview" })}
                />
            );
        }
        if (route.view === "proxy") {
            return <ProxyView onNavigate={setRoute} />;
        }
        if (route.view === "tasks") {
            return <TasksView />;
        }
        if (route.view === "settings") {
            return <SettingsView />;
        }
        if (!currentEntry) {
            return (
                <EmptyState>
                    {conn.connected ? "This server no longer exists." : "Connecting to backend…"}
                </EmptyState>
            );
        }
        // A capability the agent positively reported missing replaces the tab
        // outright: the view behind it would only fire doomed requests, and this
        // is the surface that can actually explain the gap. Unknown (older agent,
        // never probed) deliberately falls through to the normal view.
        const tabSpec = SERVER_TABS.find((t) => t.id === route.tab);
        const gated = tabSpec?.requires ? hostCapability(currentEntry.status, tabSpec.requires) : undefined;
        if (tabSpec?.requires && gated?.available === false) {
            return (
                <HostCapabilityNotice
                    serverId={currentEntry.id}
                    capability={tabSpec.requires}
                    label={tabSpec.label}
                    result={gated}
                />
            );
        }

        switch (route.tab) {
            case "overview":
                return <HostDashboard entry={currentEntry} />;
            case "files":
                return (
                    <FilesView
                        serverId={currentEntry.id}
                        path={route.path ?? "/"}
                        openFile={route.file ?? null}
                        onNavigate={(patch) => setRoute({
                            view: "server",
                            serverId: currentEntry.id,
                            tab: "files",
                            path: patch.path ?? route.path ?? "/",
                            file: "file" in patch ? patch.file ?? undefined : route.file,
                        })}
                    />
                );
            case "docker":
                return (
                    <DockerView
                        serverId={currentEntry.id}
                        section={route.section ?? "overview"}
                        volume={route.volume}
                        path={route.path}
                        file={route.file ?? null}
                        filter={route.filter}
                        stack={route.stack}
                        containerId={route.containerId}
                        stackId={route.stackId}
                        stackTab={route.stackTab ?? "overview"}
                        servers={conn.servers}
                        onNavigate={(next) => setRoute({
                            view: "server",
                            serverId: currentEntry.id,
                            tab: "docker",
                            ...next,
                        })}
                    />
                );
            case "zfs":
                return (
                    <ZfsView
                        serverId={currentEntry.id}
                        section={route.zfsSection ?? "pools"}
                        onNavigate={(next) => setRoute({
                            view: "server",
                            serverId: currentEntry.id,
                            tab: "zfs",
                            ...next,
                        })}
                    />
                );
            case "mounts":
                return <MountsView serverId={currentEntry.id} />;
            case "processes":
                return <ProcessesView serverId={currentEntry.id} />;
            case "network":
                return <NetworkView serverId={currentEntry.id} />;
            case "services":
                return <ServicesView serverId={currentEntry.id} />;
            case "users":
                return <SystemUsersView serverId={currentEntry.id} />;
            case "terminal":
                return <TerminalView serverId={currentEntry.id} />;
        }
    }

    return (
        <div className={styles.app}>
            <Sidebar
                servers={conn.servers}
                route={route}
                backendConnected={conn.connected}
                onNavigate={setRoute}
                onLogout={onLogout}
            />
            <main className={styles.main}>
                <TopBar onNavigate={setRoute} />
                {renderMain()}
            </main>
            <TaskWidget />
            <TaskModal />
        </div>
    );
}

export default function App() {
    const auth = useAuth();

    if (auth.loading) {
        return <EmptyState>Loading…</EmptyState>;
    }
    if (auth.needsSetup) {
        return <LoginView mode="setup" onSubmit={auth.setup} />;
    }
    if (!auth.user) {
        return <LoginView mode="login" onSubmit={auth.login} />;
    }
    return (
        <CurrentUserProvider user={auth.user}>
            <AuthedApp onLogout={auth.logout} />
        </CurrentUserProvider>
    );
}

console.log("hello world", import.meta.env);