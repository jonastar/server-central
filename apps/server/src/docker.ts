import type {
    AppRunStatus,
    AppServiceStatus,
    AppStatus,
    ContainerAction,
    ContainerInfo,
    DockerContainerDetail,
    DockerExecResult,
    DockerImageInfo,
    DockerMount,
    DockerOverview,
    DockerStack,
    DockerStacksState,
    DockerState,
    DockerVolumeDetail,
    DockerVolumeInfo,
    ImageAction,
    ImageDefaults,
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

/**
 * The full (bounded) error output of a failed docker command. Docker often
 * prints the useful daemon error first and a generic summary last ("Error:
 * failed to start containers: <id>"), so returning any single line hides the
 * cause — return everything, newlines collapsed for one-banner display.
 */
function errorText(res: { stdout: string; stderr: string }): string {
    const text = (res.stdout + res.stderr).trim().split("\n").map((l) => l.trim()).filter(Boolean).join(" — ");
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
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

export async function dockerStackAction(
    server: HostAgent,
    project: string,
    action: StackAction,
    onLog?: (text: string) => void,
): Promise<void> {
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
    onLog?.(res.stdout);
    if (res.code !== 0) {
        throw new Error(errorText(res) || `docker ${action} failed`);
    }
}

/** Single-quote a string for safe inclusion in a shell command, escaping any
 *  embedded single quotes. Used for App directories/compose paths, which come
 *  from SC-created or operator-picked (`DirectoryPicker`) locations — real
 *  filesystem paths, not `SAFE_ID_RE`-shaped identifiers. */
function shQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type ComposeAction = "up" | "restart" | "stop" | "down";

/**
 * Run a compose verb against an App's compose file directly (`cd <dir> &&
 * docker compose -f <composeFile> -p <project> <verb>`). Unlike
 * `dockerStackAction`, this works even when the project has zero
 * containers — a freshly created App, or one that's been `down`, since it
 * drives from the compose file rather than an existing container-id lookup.
 *
 * `service`, when given, scopes the action to one service instead of the
 * whole project. compose has no native per-service `down` (`down` always
 * tears down the whole project — network included); a scoped "down" is
 * approximated as `stop` + `rm -f` on just that service, leaving the network
 * and every other service's container untouched.
 */
export async function composeStackAction(
    server: HostAgent,
    dir: string,
    composeFile: string,
    project: string,
    action: ComposeAction,
    pullFirst?: boolean,
    onLog?: (text: string) => void,
    service?: string,
): Promise<void> {
    if (!SAFE_ID_RE.test(project)) {
        throw new Error(`Invalid project name: ${project}`);
    }
    if (service !== undefined && !SAFE_ID_RE.test(service)) {
        throw new Error(`Invalid service name: ${service}`);
    }
    const svc = service ? ` ${service}` : "";
    const base = `cd ${shQuote(dir)} && docker compose -f ${shQuote(composeFile)} -p ${project}`;
    if (pullFirst) {
        const pull = await server.exec(`${base} pull${svc} 2>&1`);
        onLog?.(pull.stdout);
        if (pull.code !== 0) {
            throw new Error(errorText(pull) || "docker compose pull failed");
        }
    }
    if (action === "down" && service) {
        const stop = await server.exec(`${base} stop${svc} 2>&1`);
        onLog?.(stop.stdout);
        if (stop.code !== 0) {
            throw new Error(errorText(stop) || "docker compose stop failed");
        }
        const rm = await server.exec(`${base} rm -f${svc} 2>&1`);
        onLog?.(rm.stdout);
        if (rm.code !== 0) {
            throw new Error(errorText(rm) || "docker compose rm failed");
        }
        return;
    }
    const verb = action === "up" ? "up -d" : action;
    const res = await server.exec(`${base} ${verb}${svc} 2>&1`);
    onLog?.(res.stdout);
    if (res.code !== 0) {
        throw new Error(errorText(res) || `docker compose ${action} failed`);
    }
}

interface ComposeConfigJson {
    services?: Record<string, { image?: string; volumes?: { type: string; source?: string; target?: string }[] }>;
    volumes?: Record<string, unknown>;
}

export interface ComposeConfigResult {
    config: ComposeConfigJson | null;
    /** Set when docker compose config failed or returned unparsable output —
     *  lets callers tell "genuinely no services declared" apart from "couldn't
     *  ask docker compose" (e.g. `getAppStatus`'s services list vs `AppDetection.composeError`). */
    error?: string;
}

/**
 * Resolved compose config (`docker compose config --format json`) — works even
 * when the project has never run, since it only parses the compose file on
 * disk. `config` is null if the file is missing, invalid, or docker compose
 * fails for any other reason (the caller treats that as "nothing usable found" —
 * see `AppDetection.composeFound`/`getAppStatus`'s `"down"` fallback); `error`
 * carries why. Deliberately doesn't merge stderr into stdout (unlike most other
 * commands in this file) — compose v2 writes deprecation warnings (e.g. the
 * legacy top-level `version:` key) to stderr even on success, and merging them
 * in front of the JSON broke `JSON.parse` for any real-world compose file that
 * still had one.
 */
export async function composeConfig(
    server: HostAgent,
    dir: string,
    composeFile: string,
    project: string,
): Promise<ComposeConfigResult> {
    if (!SAFE_ID_RE.test(project)) {
        throw new Error(`Invalid project name: ${project}`);
    }
    const res = await server.exec(`cd ${shQuote(dir)} && docker compose -f ${shQuote(composeFile)} -p ${project} config --format json`);
    if (res.code !== 0) {
        return { config: null, error: errorText(res) || "docker compose config failed" };
    }
    try {
        return { config: JSON.parse(res.stdout) as ComposeConfigJson };
    } catch {
        return { config: null, error: errorText(res) || "docker compose config returned unparsable output" };
    }
}

/**
 * Validates in-editor compose content with `docker compose config` before it's
 * saved — catches things schema validation alone can't (interpolation errors,
 * semantic rejections). Writes to a sibling temp file (same dir as the real
 * compose file, so relative bind-mount paths resolve the same way they would for
 * the real file) rather than `dir`'s actual compose file, so an invalid draft
 * never touches the file `docker_compose_action` deploys from.
 */
export async function validateComposeContent(
    server: HostAgent,
    dir: string,
    project: string,
    content: string,
): Promise<{ valid: true } | { valid: false; error: string }> {
    if (!SAFE_ID_RE.test(project)) {
        throw new Error(`Invalid project name: ${project}`);
    }
    const tempName = `.sc-validate-${crypto.randomUUID()}.yaml`;
    const tempPath = dir.endsWith("/") ? `${dir}${tempName}` : `${dir}/${tempName}`;
    await server.writeFile(tempPath, content);
    try {
        const res = await server.exec(`cd ${shQuote(dir)} && docker compose -f ${shQuote(tempName)} -p ${project} config --format json 2>&1`);
        return res.code === 0 ? { valid: true } : { valid: false, error: errorText(res) || "docker compose config failed" };
    } finally {
        await server.deletePath(tempPath).catch(() => { /* best-effort cleanup */ });
    }
}

interface ComposePsEntry {
    Service: string;
    Image?: string;
    State?: string;
    Publishers?: { TargetPort?: number; PublishedPort?: number; Protocol?: string }[];
}

/** `docker compose ps`'s `Publishers` has one entry per (host IP, port) bind —
 *  a port published without a specific host IP gets both an IPv4 (`0.0.0.0`)
 *  and an IPv6 (`::`) entry for the same logical mapping, which duplicated the
 *  port in the summary string. Dedupe by published/target/protocol, ignoring
 *  which IP it's bound on. */
function formatPorts(entry: ComposePsEntry): string | undefined {
    const pubs = (entry.Publishers ?? []).filter((p) => p.PublishedPort);
    const seen = new Set<string>();
    const unique = pubs.filter((p) => {
        const key = `${p.PublishedPort}/${p.TargetPort}/${p.Protocol ?? "tcp"}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
    return unique.length === 0 ? undefined : unique.map((p) => `${p.PublishedPort}→${p.TargetPort}`).join(", ");
}

/**
 * Merges the compose file's declared services with `docker compose ps`'s view
 * of what's actually running, for the App system's status badge + services
 * table — deliberately simpler than a full running/disk/reconcile merge
 * (doc/idea_stack_registry.md §2): docker's own CLI does the compose-file
 * parsing, so there's no YAML dependency or predicted-name ambiguity to own.
 */
export async function getAppStatus(
    server: HostAgent,
    dir: string,
    composeFile: string,
    project: string,
): Promise<AppStatus> {
    const { config } = await composeConfig(server, dir, composeFile, project);
    const declared = config ? Object.keys(config.services ?? {}) : [];

    const psRes = await server.exec(`cd ${shQuote(dir)} && docker compose -f ${shQuote(composeFile)} -p ${project} ps --format json --all 2>&1`);
    const present = psRes.code === 0 ? parseJsonLines<ComposePsEntry>(psRes.stdout) : [];
    const byService = new Map(present.map((e) => [e.Service, e]));

    const services: AppServiceStatus[] = declared.map((name) => {
        const entry = byService.get(name);
        return {
            name,
            image: entry?.Image ?? config?.services?.[name]?.image,
            state: entry?.State,
            ports: entry ? formatPorts(entry) : undefined,
            up: entry?.State === "running",
        };
    });

    const upCount = services.filter((s) => s.up).length;
    const status: AppRunStatus =
        declared.length === 0 || present.length === 0 ? "down"
            : upCount === 0 ? "stopped"
                : upCount === declared.length ? "running"
                    : "partial";

    return { status, services };
}

/** `docker compose logs`, optionally scoped to one service — one-shot, not
 *  streaming (same 30s exec ceiling noted throughout this file's App-facing
 *  helpers). Compose's own service-name line prefix does the "which service"
 *  labeling; `--no-color` keeps the output plain since the frontend renders
 *  it through the same ANSI-aware LogViewer as everything else, not raw. */
export async function getAppLogs(
    server: HostAgent,
    dir: string,
    composeFile: string,
    project: string,
    service: string | undefined,
    tail: number,
): Promise<string> {
    if (!SAFE_ID_RE.test(project)) {
        throw new Error(`Invalid project name: ${project}`);
    }
    if (service && !SAFE_ID_RE.test(service)) {
        throw new Error(`Invalid service name: ${service}`);
    }
    const svc = service ? ` ${service}` : "";
    const res = await server.exec(`cd ${shQuote(dir)} && docker compose -f ${shQuote(composeFile)} -p ${project} logs --no-color --tail ${Math.max(1, Math.floor(tail))}${svc} 2>&1`);
    return res.stdout;
}

export async function dockerContainerAction(
    server: HostAgent,
    containerId: string,
    action: ContainerAction,
    onLog?: (text: string) => void,
): Promise<void> {
    if (!SAFE_ID_RE.test(containerId)) {
        throw new Error(`Invalid container id: ${containerId}`);
    }
    const cmd = action === "remove" ? "rm -f" : action;
    const res = await server.exec(`docker ${cmd} ${containerId} 2>&1`);
    onLog?.(res.stdout);
    if (res.code !== 0) {
        throw new Error(errorText(res) || `docker ${action} failed`);
    }
}

export async function dockerContainerInspect(server: HostAgent, containerId: string): Promise<DockerContainerDetail> {
    if (!SAFE_ID_RE.test(containerId)) {
        throw new Error(`Invalid container id: ${containerId}`);
    }
    const res = await server.exec(`docker inspect ${containerId}`);
    if (res.code !== 0) {
        throw new Error(errorText(res) || "docker inspect failed");
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

    const labels = Object.entries(c.Config?.Labels ?? {})
        .map(([key, value]) => ({ key, value: String(value) }))
        .sort((a, b) => a.key.localeCompare(b.key));

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
        labels,
        raw: JSON.stringify(c, null, 2),
    };
}

/**
 * Run a one-shot, non-interactive command inside a container (`docker exec`,
 * wrapped in `sh -c` so pipes/redirects in the typed command work). Doesn't
 * throw on a non-zero exit — the caller typed an arbitrary command and wants
 * to see exactly what it printed, success or not, same as a real terminal.
 */
export async function dockerContainerExec(server: HostAgent, containerId: string, command: string): Promise<DockerExecResult> {
    if (!SAFE_ID_RE.test(containerId)) {
        throw new Error(`Invalid container id: ${containerId}`);
    }
    return server.exec(`docker exec ${containerId} sh -c ${shQuote(command)}`);
}

/**
 * Shell command for an interactive `docker exec` terminal session (used by
 * the `openShell` bridge for the container Terminal tab) — same id validation
 * as {@link dockerContainerExec}, but returns the command string instead of
 * running it, since this path spawns a real PTY rather than a one-shot exec.
 * Tries bash first, falling back to sh for minimal images that lack it.
 *
 * `command -v bash && exec bash; exec sh` — not `exec bash || exec sh`: POSIX
 * mandates that when `exec` fails to find its target in a *non-interactive*
 * shell (which `sh -c '...'` always is), the shell exits immediately instead
 * of continuing on to evaluate `||` — so the "fallback" branch would never
 * run, and every bash-less image (alpine included) would 127 with no output.
 * Checking existence first, without invoking `exec`, sidesteps that entirely.
 */
export function dockerContainerShellCommand(containerId: string): string {
    if (!SAFE_ID_RE.test(containerId)) {
        throw new Error(`Invalid container id: ${containerId}`);
    }
    return `docker exec -it ${containerId} sh -c "command -v bash >/dev/null 2>&1 && exec bash -l; exec sh"`;
}

/** Same as {@link dockerContainerExec} but targets a compose service by name
 *  (`docker compose exec -T`) instead of a resolved container id — for the
 *  App page, which only knows services, not container ids. `-T` disables PTY
 *  allocation since this isn't an attached interactive session. */
export async function composeServiceExec(
    server: HostAgent,
    dir: string,
    composeFile: string,
    project: string,
    service: string,
    command: string,
): Promise<DockerExecResult> {
    if (!SAFE_ID_RE.test(project)) {
        throw new Error(`Invalid project name: ${project}`);
    }
    if (!SAFE_ID_RE.test(service)) {
        throw new Error(`Invalid service name: ${service}`);
    }
    return server.exec(`cd ${shQuote(dir)} && docker compose -f ${shQuote(composeFile)} -p ${project} exec -T ${service} sh -c ${shQuote(command)}`);
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
        throw new Error(errorText(inspect) || "docker volume inspect failed");
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
        throw new Error(errorText(res) || "docker volume rm failed");
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
        throw new Error(errorText(res) || "docker rmi failed");
    }
}

export async function dockerImagePull(
    server: HostAgent,
    ref: string,
    onLog?: (text: string) => void,
): Promise<{ ok: boolean; message: string }> {
    if (!SAFE_REF_RE.test(ref)) {
        throw new Error(`Invalid image reference: ${ref}`);
    }
    const res = await server.exec(`docker pull ${ref} 2>&1`);
    const message = (res.stdout + res.stderr).trim();
    onLog?.(message);
    if (res.code !== 0) {
        return { ok: false, message: message.split("\n").filter(Boolean).pop() || "docker pull failed" };
    }
    return { ok: true, message: message.split("\n").filter(Boolean).pop() || `Pulled ${ref}` };
}

interface ImageConfigJson {
    Env?: string[];
    ExposedPorts?: Record<string, unknown>;
    Volumes?: Record<string, unknown>;
}

const EMPTY_IMAGE_DEFAULTS: ImageDefaults = { volumes: [], ports: [], env: [] };

/**
 * What an image's Dockerfile already declared — `VOLUME`, `EXPOSE`, `ENV` —
 * read from a single `docker image inspect --format '{{json .Config}}'` call
 * (one exec covers all three, rather than one inspect per field). Cheap: no
 * pull or run, so it only works if the image is already present locally;
 * returns all-empty rather than triggering a pull otherwise (pulls belong to
 * the task system — see `dockerImagePull`'s note on the 30s exec ceiling).
 */
export async function imageDefaults(server: HostAgent, image: string): Promise<ImageDefaults> {
    if (!SAFE_REF_RE.test(image)) {
        throw new Error(`Invalid image reference: ${image}`);
    }
    const res = await server.exec(`docker image inspect ${image} --format '{{json .Config}}' 2>&1`);
    if (res.code !== 0) {
        return EMPTY_IMAGE_DEFAULTS;
    }
    try {
        const cfg = JSON.parse(res.stdout.trim()) as ImageConfigJson | null;
        if (!cfg) {
            return EMPTY_IMAGE_DEFAULTS;
        }
        const volumes = cfg.Volumes ? Object.keys(cfg.Volumes).sort() : [];
        const ports = cfg.ExposedPorts
            ? Object.keys(cfg.ExposedPorts)
                .map((k) => {
                    const [portStr, proto] = k.split("/");
                    return { port: Number(portStr), protocol: (proto === "udp" ? "udp" : "tcp") as "tcp" | "udp" };
                })
                .filter((p) => Number.isFinite(p.port))
                .sort((a, b) => a.port - b.port)
            : [];
        const env = (cfg.Env ?? []).map((s) => {
            const i = s.indexOf("=");
            return i === -1 ? { key: s, value: "" } : { key: s.slice(0, i), value: s.slice(i + 1) };
        });
        return { volumes, ports, env };
    } catch {
        return EMPTY_IMAGE_DEFAULTS;
    }
}
