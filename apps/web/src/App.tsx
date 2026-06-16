import { useConnection } from "./hooks/useConnection";
import { useLocalStorageState } from "./hooks/useLocalStorageState";
import type { Route } from "./routes";
import { Sidebar } from "./components/Sidebar";
import { Dashboard } from "./components/Dashboard";
import { ServerOverview } from "./components/ServerOverview";
import { FilesView } from "./components/FilesView";
import { DockerView } from "./components/DockerView";
import { ProcessesView } from "./components/ProcessesView";
import { TerminalView } from "./components/TerminalView";
import { SettingsView } from "./components/SettingsView";
import { EmptyState } from "./components/ui";

export default function App() {
    const conn = useConnection();
    const [route, setRoute] = useLocalStorageState<Route>("central.route", { view: "dashboard" });

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
                return <FilesView serverId={currentEntry.id} />;
            case "docker":
                return <DockerView serverId={currentEntry.id} />;
            case "processes":
                return <ProcessesView serverId={currentEntry.id} />;
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
            />
            <main className="main">{renderMain()}</main>
        </div>
    );
}
