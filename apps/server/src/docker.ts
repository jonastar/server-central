import type { ContainerAction, ContainerInfo, DockerImageInfo, DockerState, DockerVolumeInfo } from "@central/shared";
import type { HostAgent } from "./agent";

const SAFE_ID_RE = /^[A-Za-z0-9_.-]+$/;

function parseJsonLines<T>(text: string): T[] {
    const out: T[] = [];
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            out.push(JSON.parse(trimmed) as T);
        } catch { /* skip malformed line */ }
    }
    return out;
}

export async function dockerList(server: HostAgent): Promise<DockerState> {
    const probe = await server.exec("docker version --format '{{.Server.Version}}' 2>&1");
    if (probe.code !== 0) {
        return {
            available: false,
            error: (probe.stdout + probe.stderr).trim().split("\n")[0] || "docker unavailable",
            containers: [],
            volumes: [],
            images: [],
        };
    }

    const [ps, volumes, images] = await Promise.all([
        server.exec("docker ps -a --format '{{json .}}'"),
        server.exec("docker volume ls --format '{{json .}}'"),
        server.exec("docker images --format '{{json .}}'"),
    ]);

    type PsRow = { ID: string; Names: string; Image: string; State: string; Status: string; Ports: string; CreatedAt: string };
    type VolRow = { Name: string; Driver: string; Mountpoint?: string };
    type ImgRow = { ID: string; Repository: string; Tag: string; Size: string; CreatedSince: string };

    const containers: ContainerInfo[] = parseJsonLines<PsRow>(ps.stdout).map((r) => ({
        id: r.ID,
        name: r.Names,
        image: r.Image,
        state: r.State,
        status: r.Status,
        ports: r.Ports,
        createdAt: r.CreatedAt,
    }));
    const vols: DockerVolumeInfo[] = parseJsonLines<VolRow>(volumes.stdout).map((r) => ({
        name: r.Name,
        driver: r.Driver,
        mountpoint: r.Mountpoint ?? "",
    }));
    const imgs: DockerImageInfo[] = parseJsonLines<ImgRow>(images.stdout).map((r) => ({
        id: r.ID,
        repository: r.Repository,
        tag: r.Tag,
        size: r.Size,
        createdSince: r.CreatedSince,
    }));

    return { available: true, containers, volumes: vols, images: imgs };
}

export async function dockerContainerAction(
    server: HostAgent,
    containerId: string,
    action: ContainerAction,
): Promise<void> {
    if (!SAFE_ID_RE.test(containerId)) throw new Error(`Invalid container id: ${containerId}`);
    const cmd = action === "remove" ? "rm -f" : action;
    const res = await server.exec(`docker ${cmd} ${containerId} 2>&1`);
    if (res.code !== 0) {
        throw new Error((res.stdout + res.stderr).trim().split("\n").pop() || `docker ${action} failed`);
    }
}

export async function dockerContainerLogs(
    server: HostAgent,
    containerId: string,
    tail: number,
): Promise<string> {
    if (!SAFE_ID_RE.test(containerId)) throw new Error(`Invalid container id: ${containerId}`);
    const res = await server.exec(`docker logs --tail ${Math.floor(tail)} ${containerId} 2>&1`);
    return res.stdout;
}
