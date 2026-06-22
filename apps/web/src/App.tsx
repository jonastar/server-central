import { useEffect } from "react";
import { useConnection } from "./hooks/useConnection";
import { useHashRoute } from "./hooks/useHashRoute";
import { useAuth } from "./hooks/useAuth";
import { connectionManager } from "./connection";
import { LoginView } from "./components/LoginView";
import { Sidebar } from "./components/Sidebar";
import { Dashboard } from "./components/Dashboard";
import { AgentsView } from "./components/AgentsView";
import { ServerOverview } from "./components/ServerOverview";
import { FilesView } from "./components/FilesView";
import { DockerView } from "./components/DockerView";
import { ProcessesView } from "./components/ProcessesView";
import { NetworkView } from "./components/NetworkView";
import { ServicesView } from "./components/ServicesView";
import { TerminalView } from "./components/TerminalView";
import { SettingsView } from "./components/SettingsView";
import { EmptyState } from "./components/ui";

function AuthedApp({ onLogout }: { onLogout: () => void }) {
    const conn = useConnection();
    const [route, setRoute] = useHashRoute();

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
                        onNavigate={(next) => setRoute({
                            view: "server",
                            serverId: currentEntry.id,
                            tab: "docker",
                            ...next,
                        })}
                    />
                );
            case "processes":
                return <ProcessesView serverId={currentEntry.id} />;
            case "network":
                return <NetworkView serverId={currentEntry.id} />;
            case "services":
                return <ServicesView serverId={currentEntry.id} />;
            case "terminal":
                return <TerminalView serverId={currentEntry.id} />;
        }
    }

    return (
        <div className="app">
            <Sidebar
                servers={conn.servers}
                route={route}
                backendConnected={conn.connected}
                onNavigate={setRoute}
                onLogout={onLogout}
            />
            <main className="main">{renderMain()}</main>
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
