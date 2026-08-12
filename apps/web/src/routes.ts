export type ServerTab = "overview" | "files" | "docker" | "processes" | "network" | "services" | "users" | "zfs" | "mounts" | "terminal";

export type DockerSection = "overview" | "stacks" | "containers" | "volumes" | "images";
export type ZfsSection = "pools" | "datasets" | "snapshots";

export type Route =
    | { view: "dashboard" }
    | { view: "agents" }
    | { view: "proxy" }
    | { view: "tasks" }
    | { view: "settings" }
    | {
          view: "server";
          serverId: string;
          tab: ServerTab;
          /** Docker tab only: active sub-section. Defaults to "overview". */
          section?: DockerSection;
          /** Docker tab, volumes section only: the volume being browsed. */
          volume?: string;
          /** Files tab / volume browser: current folder. Defaults to "/". */
          path?: string;
          /** Files tab / volume browser: path of the open file, if any. */
          file?: string;
          /** Docker tab, containers section only: initial name/image/stack
           *  filter — lets other views deep-link to a specific container. */
          filter?: string;
          /** ZFS tab only: active sub-section. Defaults to "pools". */
          zfsSection?: ZfsSection;
      };

const DOCKER_SECTIONS = new Set<DockerSection>(["overview", "stacks", "containers", "volumes", "images"]);
const ZFS_SECTIONS = new Set<ZfsSection>(["pools", "datasets", "snapshots"]);

export const SERVER_TABS: Array<{ id: ServerTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "files", label: "Files" },
    { id: "docker", label: "Docker" },
    { id: "zfs", label: "ZFS" },
    { id: "mounts", label: "Mounts" },
    { id: "processes", label: "Processes" },
    { id: "network", label: "Network" },
    { id: "services", label: "Services" },
    { id: "users", label: "Users" },
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
        case "proxy":
            return "#/proxy";
        case "tasks":
            return "#/tasks";
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
            } else if (route.tab === "docker") {
                hash += `/${route.section ?? "overview"}`;
                if (route.section === "containers" && route.filter) {
                    hash += `?q=${encodeURIComponent(route.filter)}`;
                }
                if (route.section === "volumes" && route.volume) {
                    hash += `/${encodeURIComponent(route.volume)}`;
                    const encoded = route.path ? encodePath(route.path) : "";
                    if (encoded) {
                        hash += `/${encoded}`;
                    }
                    if (route.file) {
                        hash += `?f=${encodeURIComponent(route.file)}`;
                    }
                }
            } else if (route.tab === "zfs") {
                hash += `/${route.zfsSection ?? "pools"}`;
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
    if (segs[0] === "proxy") {
        return { view: "proxy" };
    }
    if (segs[0] === "tasks") {
        return { view: "tasks" };
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
        if (tab === "docker") {
            const sectionSeg = segs[3] as DockerSection | undefined;
            const section = sectionSeg && DOCKER_SECTIONS.has(sectionSeg) ? sectionSeg : "overview";
            if (section === "volumes" && segs[4]) {
                const volume = decodeURIComponent(segs[4]);
                const path = segs.length > 5 ? "/" + segs.slice(5).map(decodeURIComponent).join("/") : undefined;
                const file = new URLSearchParams(queryPart).get("f") ?? undefined;
                return { view: "server", serverId, tab, section, volume, path, file };
            }
            if (section === "containers") {
                const filter = new URLSearchParams(queryPart).get("q") ?? undefined;
                return { view: "server", serverId, tab, section, filter };
            }
            return { view: "server", serverId, tab, section };
        }
        if (tab === "zfs") {
            const zfsSectionSeg = segs[3] as ZfsSection | undefined;
            const zfsSection = zfsSectionSeg && ZFS_SECTIONS.has(zfsSectionSeg) ? zfsSectionSeg : "pools";
            return { view: "server", serverId, tab, zfsSection };
        }
        return { view: "server", serverId, tab };
    }

    return { view: "dashboard" };
}
