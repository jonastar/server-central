import type {
    ContainerAction,
    ContainerInfo,
    DockerContainerDetail,
    DockerImageInfo,
    DockerMount,
    DockerOverview,
    DockerStack,
    DockerStacksState,
    DockerState,
    DockerVolumeDetail,
    DockerVolumeInfo,
    ImageAction,
    LogQuery,
    StackAction,
} from "@central/shared";
import type { HostAgent } from "./host-agent";
import { dockerSince, reverseLines } from "./log-query";

const SAFE_ID_RE = /^[A-Za-z0-9_.-]+$/;
const SAFE_REF_RE = /^[A-Za-z0-9_./:@-]+$/;

function parseJsonLines<T>(text: string): T[] {
    const out: T[] = [];
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        try {
            out.push(JSON.parse(trimmed) as T);
        } catch { /* skip malformed line */ }
    }
    return out;
}

/** Pull a single key=value out of docker's comma-joined `.Labels` string. */
function parseLabel(labels: string | undefined, key: string): string | undefined {
    if (!labels) {
        return undefined;
    }
    for (const pair of labels.split(",")) {
        const eq = pair.indexOf("=");
        if (eq > 0 && pair.slice(0, eq) === key) {
            return pair.slice(eq + 1);
        }
    }
    return undefined;
}

function firstErrorLine(res: { stdout: string; stderr: string }): string {
    return (res.stdout + res.stderr).trim().split("\n").filter(Boolean).pop() || "";
}

type PsRow = {
    ID: string;
    Names: string;
    Image: string;
    State: string;
    Status: string;
    Ports: string;
    CreatedAt: string;
    Labels?: string;
};

function toContainer(r: PsRow): ContainerInfo {
    return {
        id: r.ID,
        name: r.Names,
        image: r.Image,
        state: r.State,
        status: r.Status,
        ports: r.Ports,
        createdAt: r.CreatedAt,
        project: parseLabel(r.Labels, "com.docker.compose.project"),
        service: parseLabel(r.Labels, "com.docker.compose.service"),
    };
}

async function probe(server: HostAgent): Promise<string | null> {
    const res = await server.exec("docker version --format '{{.Server.Version}}' 2>&1");
    if (res.code !== 0) {
        return (res.stdout + res.stderr).trim().split("\n")[0] || "docker unavailable";
    }
    return null;
}

export async function dockerList(server: HostAgent): Promise<DockerState> {
    const err = await probe(server);
    if (err) {
        return { available: false, error: err, containers: [], volumes: [], images: [] };
    }

    const [ps, volumes, images] = await Promise.all([
        server.exec("docker ps -a --format '{{json .}}'"),
        server.exec("docker volume ls --format '{{json .}}'"),
        server.exec("docker images --format '{{json .}}'"),
    ]);

    type VolRow = { Name: string; Driver: string; Mountpoint?: string };
    type ImgRow = { ID: string; Repository: string; Tag: string; Size: string; CreatedSince: string };

    const containers: ContainerInfo[] = parseJsonLines<PsRow>(ps.stdout).map(toContainer);
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

export async function dockerOverview(server: HostAgent): Promise<DockerOverview> {
    const err = await probe(server);
    if (err) {
        return { available: false, error: err, containersRunning: 0, containersTotal: 0, stacks: 0, volumes: 0, images: 0 };
    }

    const [ps, vols, imgs, df] = await Promise.all([
        server.exec("docker ps -a --format '{{json .}}'"),
        server.exec("docker volume ls --format '{{json .}}'"),
        server.exec("docker images --format '{{json .}}'"),
        server.exec("docker system df --format '{{json .}}'"),
    ]);

    const containers = parseJsonLines<PsRow>(ps.stdout);
    const running = containers.filter((c) => c.State === "running").length;
    const projects = new Set<string>();
    for (const c of containers) {
        const p = parseLabel(c.Labels, "com.docker.compose.project");
        if (p) {
            projects.add(p);
        }
    }

    // `docker system df` emits one JSON object per row keyed by Type.
    type DfRow = { Type: string; Size: string; Reclaimable: string };
    const dfRows = parseJsonLines<DfRow>(df.stdout);
    const dfFor = (type: string) => dfRows.find((r) => r.Type === type)?.Size ?? "—";

    return {
        available: true,
        containersRunning: running,
        containersTotal: containers.length,
        stacks: projects.size,
        volumes: parseJsonLines(vols.stdout).length,
        images: parseJsonLines(imgs.stdout).length,
        df: {
            images: dfFor("Images"),
            containers: dfFor("Containers"),
            volumes: dfFor("Local Volumes"),
            buildCache: dfFor("Build Cache"),
        },
    };
}

export async function dockerStacks(server: HostAgent): Promise<DockerStacksState> {
    const err = await probe(server);
    if (err) {
        return { available: false, error: err, stacks: [] };
    }

    const ps = await server.exec("docker ps -a --format '{{json .}}'");
    const containers = parseJsonLines<PsRow>(ps.stdout);

    const byProject = new Map<string, DockerStack>();
    for (const c of containers) {
        const project = parseLabel(c.Labels, "com.docker.compose.project");
        if (!project) {
            continue;
        }
        let stack = byProject.get(project);
        if (!stack) {
            stack = {
                project,
                containers: 0,
                running: 0,
                configFiles: parseLabel(c.Labels, "com.docker.compose.project.config_files") ?? "",
                states: [],
            };
            byProject.set(project, stack);
        }
        stack.containers += 1;
        if (c.State === "running") {
            stack.running += 1;
        }
        if (!stack.states.includes(c.State)) {
            stack.states.push(c.State);
        }
    }

    const stacks = [...byProject.values()].sort((a, b) => a.project.localeCompare(b.project));
    return { available: true, stacks };
}

export async function dockerStackAction(server: HostAgent, project: string, action: StackAction): Promise<void> {
    if (!SAFE_ID_RE.test(project)) {
        throw new Error(`Invalid stack name: ${project}`);
    }
    const ids = await server.exec(`docker ps -aq --filter label=com.docker.compose.project=${project}`);
    const containerIds = ids.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (containerIds.length === 0) {
        throw new Error(`No containers found for stack ${project}`);
    }
    const cmd = action === "down" ? "rm -f" : action;
    const res = await server.exec(`docker ${cmd} ${containerIds.join(" ")} 2>&1`);
    if (res.code !== 0) {
        throw new Error(firstErrorLine(res) || `docker ${action} failed`);
    }
}

export async function dockerContainerAction(
    server: HostAgent,
    containerId: string,
    action: ContainerAction,
): Promise<void> {
    if (!SAFE_ID_RE.test(containerId)) {
        throw new Error(`Invalid container id: ${containerId}`);
    }
    const cmd = action === "remove" ? "rm -f" : action;
    const res = await server.exec(`docker ${cmd} ${containerId} 2>&1`);
    if (res.code !== 0) {
        throw new Error(firstErrorLine(res) || `docker ${action} failed`);
    }
}

export async function dockerContainerInspect(server: HostAgent, containerId: string): Promise<DockerContainerDetail> {
    if (!SAFE_ID_RE.test(containerId)) {
        throw new Error(`Invalid container id: ${containerId}`);
    }
    const res = await server.exec(`docker inspect ${containerId}`);
    if (res.code !== 0) {
        throw new Error(firstErrorLine(res) || "docker inspect failed");
    }
    const arr = JSON.parse(res.stdout) as Array<Record<string, any>>;
    const c = arr[0];
    if (!c) {
        throw new Error("Container not found");
    }

    const ports: string[] = [];
    const portMap = c.NetworkSettings?.Ports ?? {};
    for (const [containerPort, bindings] of Object.entries(portMap)) {
        if (Array.isArray(bindings) && bindings.length > 0) {
            for (const b of bindings as Array<{ HostIp?: string; HostPort?: string }>) {
                ports.push(`${b.HostIp || "0.0.0.0"}:${b.HostPort} → ${containerPort}`);
            }
        } else {
            ports.push(containerPort);
        }
    }

    const mounts: DockerMount[] = (c.Mounts ?? []).map((m: any) => ({
        type: m.Type ?? "",
        source: m.Source ?? m.Name ?? "",
        destination: m.Destination ?? "",
    }));

    const networks = Object.keys(c.NetworkSettings?.Networks ?? {});
    const restart = c.HostConfig?.RestartPolicy?.Name || "no";

    return {
        id: c.Id ?? containerId,
        name: (c.Name ?? "").replace(/^\//, ""),
        image: c.Config?.Image ?? "",
        state: c.State?.Status ?? "",
        status: c.State?.Status ?? "",
        created: c.Created ?? "",
        command: Array.isArray(c.Config?.Cmd) ? c.Config.Cmd.join(" ") : (c.Config?.Cmd ?? ""),
        ports,
        mounts,
        env: c.Config?.Env ?? [],
        networks,
        restartPolicy: restart,
        raw: JSON.stringify(c, null, 2),
    };
}

export async function dockerContainerLogs(
    server: HostAgent,
    containerId: string,
    opts: LogQuery & { timestamps?: boolean },
): Promise<string> {
    if (!SAFE_ID_RE.test(containerId)) {
        throw new Error(`Invalid container id: ${containerId}`);
    }
    const flags = [`--tail ${Math.floor(opts.limit ?? 500)}`];
    const since = dockerSince(opts.since);
    if (since) {
        flags.push(`--since ${since}`);
    }
    if (opts.timestamps) {
        flags.push("--timestamps");
    }
    const res = await server.exec(`docker logs ${flags.join(" ")} ${containerId} 2>&1`);
    return opts.order === "newest" ? reverseLines(res.stdout) : res.stdout;
}

export async function dockerVolumeInspect(server: HostAgent, name: string): Promise<DockerVolumeDetail> {
    if (!SAFE_ID_RE.test(name)) {
        throw new Error(`Invalid volume name: ${name}`);
    }
    const [inspect, attached] = await Promise.all([
        server.exec(`docker volume inspect ${name}`),
        server.exec(`docker ps -a --filter volume=${name} --format '{{json .}}'`),
    ]);
    if (inspect.code !== 0) {
        throw new Error(firstErrorLine(inspect) || "docker volume inspect failed");
    }
    const v = (JSON.parse(inspect.stdout) as Array<Record<string, any>>)[0] ?? {};
    const labels = v.Labels
        ? Object.entries(v.Labels).map(([k, val]) => `${k}=${val}`).join(", ")
        : undefined;

    return {
        name,
        driver: v.Driver ?? "",
        mountpoint: v.Mountpoint ?? "",
        attached: parseJsonLines<PsRow>(attached.stdout).map((r) => ({ id: r.ID, name: r.Names })),
        createdAt: v.CreatedAt,
        labels,
    };
}

export async function dockerVolumeRemove(server: HostAgent, name: string): Promise<void> {
    if (!SAFE_ID_RE.test(name)) {
        throw new Error(`Invalid volume name: ${name}`);
    }
    const res = await server.exec(`docker volume rm ${name} 2>&1`);
    if (res.code !== 0) {
        throw new Error(firstErrorLine(res) || "docker volume rm failed");
    }
}

export async function dockerImageAction(server: HostAgent, imageId: string, action: ImageAction): Promise<void> {
    if (!SAFE_ID_RE.test(imageId)) {
        throw new Error(`Invalid image id: ${imageId}`);
    }
    if (action !== "remove") {
        throw new Error(`Unsupported image action: ${action}`);
    }
    const res = await server.exec(`docker rmi ${imageId} 2>&1`);
    if (res.code !== 0) {
        throw new Error(firstErrorLine(res) || "docker rmi failed");
    }
}

export async function dockerImagePull(server: HostAgent, ref: string): Promise<{ ok: boolean; message: string }> {
    if (!SAFE_REF_RE.test(ref)) {
        throw new Error(`Invalid image reference: ${ref}`);
    }
    const res = await server.exec(`docker pull ${ref} 2>&1`);
    const message = (res.stdout + res.stderr).trim();
    if (res.code !== 0) {
        return { ok: false, message: message.split("\n").filter(Boolean).pop() || "docker pull failed" };
    }
    return { ok: true, message: message.split("\n").filter(Boolean).pop() || `Pulled ${ref}` };
}
