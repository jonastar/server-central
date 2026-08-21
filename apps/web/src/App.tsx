import { useEffect } from "react";
import { useConnection } from "./hooks/useConnection";
import { useHashRoute } from "./hooks/useHashRoute";
import { leavesTerminalSession, SERVER_TABS, type Route } from "./routes";
import { hostCapability } from "./utils";
import { HostCapabilityNotice } from "./components/HostCapabilityNotice";
import { terminalNeedsLeaveConfirm } from "./terminalSession";
import { useAuth } from "./hooks/useAuth";
import { connectionManager } from "./connection";
import { LoginView } from "./components/LoginView";
import { Sidebar } from "./components/Sidebar";
import { Dashboard } from "./components/Dashboard";
import { AgentsView } from "./components/AgentsView";
import { AppsView } from "./components/AppsView";
import { AppView } from "./components/AppView";
import { ServerOverview } from "./components/ServerOverview";
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
        if (route.view === "apps") {
            return (
                <AppsView
                    servers={conn.servers}
                    onOpenApp={(appId) => setRoute({ view: "app", appId, tab: "overview" })}
                />
            );
        }
        if (route.view === "app") {
            return (
                <AppView
                    appId={route.appId}
                    tab={route.tab}
                    servers={conn.servers}
                    onNavigate={(tab) => setRoute({ view: "app", appId: route.appId, tab })}
                    onBack={() => setRoute({ view: "apps" })}
                />
            );
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
                return <ServerOverview entry={currentEntry} history={conn.metrics[currentEntry.id] ?? []} />;
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
            <main className={styles.main}>{renderMain()}</main>
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
    return <AuthedApp onLogout={auth.logout} />;
}
