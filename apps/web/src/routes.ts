export type ServerTab = "overview" | "files" | "docker" | "processes" | "terminal";

export type Route =
    | { view: "dashboard" }
    | { view: "server"; serverId: string; tab: ServerTab }
    | { view: "settings" };

export const SERVER_TABS: Array<{ id: ServerTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "files", label: "Files" },
    { id: "docker", label: "Docker" },
    { id: "processes", label: "Processes" },
    { id: "terminal", label: "Terminal" },
];
