export type ServerTab = "overview" | "files" | "docker" | "processes" | "network" | "services" | "terminal";

export type Route =
    | { view: "dashboard" }
    | { view: "agents" }
    | { view: "settings" }
    | {
          view: "server";
          serverId: string;
          tab: ServerTab;
          /** Files tab only: current folder. Defaults to "/". */
          path?: string;
          /** Files tab only: path of the open file, if any. */
          file?: string;
      };

export const SERVER_TABS: Array<{ id: ServerTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "files", label: "Files" },
    { id: "docker", label: "Docker" },
    { id: "processes", label: "Processes" },
    { id: "network", label: "Network" },
    { id: "services", label: "Services" },
    { id: "terminal", label: "Terminal" },
];

const TAB_IDS = new Set<ServerTab>(SERVER_TABS.map((t) => t.id));

/** Encode a path's segments, preserving the leading slash. */
function encodePath(p: string): string {
    return p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/** Serialize a route to a location hash (e.g. "#/server/abc/files/etc/nginx?f=..."). */
export function routeToHash(route: Route): string {
    switch (route.view) {
        case "dashboard":
            return "#/";
        case "agents":
            return "#/agents";
        case "settings":
            return "#/settings";
        case "server": {
            let hash = `#/server/${encodeURIComponent(route.serverId)}/${route.tab}`;
            if (route.tab === "files") {
                const encoded = route.path ? encodePath(route.path) : "";
                if (encoded) {
                    hash += `/${encoded}`;
                }
                if (route.file) {
                    hash += `?f=${encodeURIComponent(route.file)}`;
                }
            }
            return hash;
        }
    }
}

/** Parse a location hash back into a route, falling back to the dashboard. */
export function hashToRoute(hash: string): Route {
    const [pathPart, queryPart = ""] = hash.replace(/^#/, "").split("?");
    const segs = pathPart.split("/").filter(Boolean);

    if (segs.length === 0) {
        return { view: "dashboard" };
    }
    if (segs[0] === "agents") {
        return { view: "agents" };
    }
    if (segs[0] === "settings") {
        return { view: "settings" };
    }

    if (segs[0] === "server" && segs[1]) {
        const serverId = decodeURIComponent(segs[1]);
        const tabSeg = segs[2] as ServerTab | undefined;
        const tab = tabSeg && TAB_IDS.has(tabSeg) ? tabSeg : "overview";
        if (tab === "files") {
            const path = "/" + segs.slice(3).map(decodeURIComponent).join("/");
            const file = new URLSearchParams(queryPart).get("f") ?? undefined;
            return { view: "server", serverId, tab, path: path === "/" ? "/" : path, file };
        }
        return { view: "server", serverId, tab };
    }

    return { view: "dashboard" };
}
