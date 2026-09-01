import type {
    ComposeStackRunStatus,
    ComposeServiceStatus,
    ComposeStackStatus,
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
import type { ExecResult, HostAgent } from "../../host-agent";
import { runStreamingLines } from "../../exec-lines";
import { dockerSince, reverseLines } from "../../log-query";

// Container ids/names, volume names, compose project and service names, image
// refs. The leading character is alphanumeric because docker requires that of
// all of them anyway — and because argv stops a value being read as *shell*
// syntax but not as docker's own option: `docker rm -f` would still parse a
// leading `-` as a flag.
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_./:@-]*$/;

// Action → the docker/compose verb it runs as. These double as the runtime guard
// on the action itself: an operation's declared union is a compile-time claim,
// and the API surface casts a parsed JSON body to it without checking, so an
// arbitrary string reaches these functions and would otherwise be interpolated
// straight into the command. Maps, not plain objects, so a key like
// "constructor" misses instead of finding something up the prototype chain.
// Built from an exhaustive Record so adding a union member fails to compile
// until its verb is named here.
const CONTAINER_VERBS = new Map<string, readonly string[]>(Object.entries({
    start: ["start"], stop: ["stop"], restart: ["restart"], remove: ["rm", "-f"], pause: ["pause"], unpause: ["unpause"],
} satisfies Record<ContainerAction, readonly string[]>));
const STACK_VERBS = new Map<string, readonly string[]>(Object.entries({
    start: ["start"], stop: ["stop"], restart: ["restart"], down: ["rm", "-f"],
} satisfies Record<StackAction, readonly string[]>));
const COMPOSE_VERBS = new Map<string, readonly string[]>(Object.entries({
    up: ["up", "-d"], restart: ["restart"], stop: ["stop"], down: ["down"], pull: ["pull"],
} satisfies Record<ComposeAction, readonly string[]>));

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
    const text = [res.stdout, res.stderr].join("\n").trim().split("\n").map((l) => l.trim()).filter(Boolean).join(" — ");
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}

/** Log text as a viewer should show it: the command's output on success, its
 *  error on failure — which is what folding stderr into stdout with `2>&1` was
 *  really buying at the two log readers below. */
function logOutput(res: ExecResult): string {
    return res.code === 0 ? res.stdout : [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
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
    const res = await server.run(["docker", "version", "--format", "{{.Server.Version}}"]);
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
        server.run(["docker", "ps", "-a", "--format", "{{json .}}"]),
        server.run(["docker", "volume", "ls", "--format", "{{json .}}"]),
        server.run(["docker", "images", "--format", "{{json .}}"]),
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
        server.run(["docker", "ps", "-a", "--format", "{{json .}}"]),
        server.run(["docker", "volume", "ls", "--format", "{{json .}}"]),
        server.run(["docker", "images", "--format", "{{json .}}"]),
        server.run(["docker", "system", "df", "--format", "{{json .}}"]),
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

    const ps = await server.run(["docker", "ps", "-a", "--format", "{{json .}}"]);
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
    const ids = await server.run(["docker", "ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`]);
    const containerIds = ids.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    if (containerIds.length === 0) {
        throw new Error(`No containers found for stack ${project}`);
    }
    const cmd = STACK_VERBS.get(action);
    if (cmd === undefined) {
        throw new Error(`Unsupported stack action: ${action}`);
    }
    const res = await server.run(["docker", ...cmd, ...containerIds]);
    onLog?.(res.stdout);
    if (res.code !== 0) {
        throw new Error(errorText(res) || `docker ${action} failed`);
    }
}

export type ComposeAction = "up" | "restart" | "stop" | "down" | "pull";

/**
 * The argv every compose command in this file starts with. Its counterpart is
 * the `{ cwd: dir }` each call passes: compose resolves relative bind mounts and
 * `env_file` paths against the working directory, which is why these ran as
 * `cd <dir> && …` before there was a way to just say so.
 */
function composeArgv(composeFile: string, project: string, ...rest: string[]): string[] {
    return ["docker", "compose", "-f", composeFile, "-p", project, ...rest];
}

/**
 * Run a compose verb against a registered stack's compose file directly (`cd <dir> &&
 * docker compose -f <composeFile> -p <project> <verb>`). Unlike
 * `dockerStackAction`, this works even when the project has zero
 * containers — a freshly created stack, or one that's been `down`, since it
 * drives from the compose file rather than an existing container-id lookup.
 *
 * `service`, when given, scopes the action to one service instead of the
 * whole project. compose has no native per-service `down` (`down` always
 * tears down the whole project — network included); a scoped "down" is
 * approximated as `stop` + `rm -f` on just that service, leaving the network
 * and every other service's container untouched.
 *
 * `"pull"` is the pull `pullFirst` performs, on its own: images are fetched and
 * nothing else runs, so a running stack keeps its current containers until the
 * next `up`.
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
    // Up front, not at the `verb` lookup below: the pull and scoped-down branches
    // both run commands of their own before that point.
    const verb = COMPOSE_VERBS.get(action);
    if (verb === undefined) {
        throw new Error(`Unsupported compose action: ${action}`);
    }
    const svc = service ? [service] : [];
    const inDir = { cwd: dir };
    if (pullFirst || action === "pull") {
        const pull = await runStreamingLines(server, composeArgv(composeFile, project, "pull", ...svc), onLog, inDir);
        if (pull.code !== 0) {
            throw new Error(errorText(pull) || "docker compose pull failed");
        }
        if (action === "pull") {
            return;
        }
    }
    if (action === "down" && service) {
        const stop = await runStreamingLines(server, composeArgv(composeFile, project, "stop", ...svc), onLog, inDir);
        if (stop.code !== 0) {
            throw new Error(errorText(stop) || "docker compose stop failed");
        }
        const rm = await runStreamingLines(server, composeArgv(composeFile, project, "rm", "-f", ...svc), onLog, inDir);
        if (rm.code !== 0) {
            throw new Error(errorText(rm) || "docker compose rm failed");
        }
        return;
    }
    const res = await runStreamingLines(server, composeArgv(composeFile, project, ...verb, ...svc), onLog, inDir);
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
     *  ask docker compose" (e.g. `getComposeStackStatus`'s services list vs `ComposeStackDetection.composeError`). */
    error?: string;
}

/**
 * Resolved compose config (`docker compose config --format json`, falling back
 * to the YAML shape of the same document — see `parseComposeConfigOutput`) —
 * works even when the project has never run, since it only parses the compose
 * file on disk. `config` is null if the file is missing, invalid, or docker
 * compose fails for any other reason (the caller treats that as "nothing usable found" —
 * see `ComposeStackDetection.composeFound`/`getComposeStackStatus`'s `"down"` fallback); `error`
 * carries why. Keeping stderr out of stdout is what makes the parse reliable:
 * compose v2 writes deprecation warnings (e.g. the legacy top-level `version:`
 * key) to stderr even on success, and folding them in front of the JSON broke
 * `JSON.parse` for any real-world compose file that still had one. That used to
 * be this function's exception to make; the streams arrive separately now.
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
    const res = await server.run(composeArgv(composeFile, project, "config", "--format", "json"), { cwd: dir });
    if (res.code !== 0) {
        return { config: null, error: errorText(res) || "docker compose config failed" };
    }
    const config = parseComposeConfigOutput(res.stdout);
    if (config) {
        return { config };
    }
    return { config: null, error: errorText(res) || "docker compose config returned unparsable output" };
}

function asConfig(parse: () => unknown): ComposeConfigJson | null {
    try {
        const doc = parse();
        return doc && typeof doc === "object" && !Array.isArray(doc) ? doc as ComposeConfigJson : null;
    } catch {
        return null;
    }
}

/**
 * Compose's canonical config output, in whichever of the two shapes it came
 * back in. `--format json` is asked for, but not every compose build honours it
 * on `config` — some print the canonical YAML regardless, which used to fail
 * `JSON.parse` and left the whole stack looking empty (0 services declared, so
 * `getComposeStackStatus` reported `"down"` even with containers running). The YAML is
 * the same canonical document with the same long-form volume entries, so
 * parsing it costs nothing beyond the second attempt. Only compose's own output
 * is parsed here, never a raw compose file — interpolation, `env_file` merging
 * and `extends` still belong to docker.
 */
function parseComposeConfigOutput(stdout: string): ComposeConfigJson | null {
    const text = stdout.trim();
    if (!text) {
        return null;
    }
    return asConfig(() => JSON.parse(text)) ?? asConfig(() => Bun.YAML.parse(text));
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
        const res = await server.run(composeArgv(tempName, project, "config", "--format", "json"), { cwd: dir });
        return res.code === 0 ? { valid: true } : { valid: false, error: errorText(res) || "docker compose config failed" };
    } finally {
        await server.deletePath(tempPath).catch(() => { /* best-effort cleanup */ });
    }
}

interface ComposePsEntry {
    ID?: string;
    Service: string;
    Image?: string;
    State?: string;
    Publishers?: { TargetPort?: number; PublishedPort?: number; Protocol?: string }[];
    /** Only set by the `docker ps` fallback, which has no `Publishers`. */
    PsPorts?: string;
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

/** Published-port pairs out of `docker ps`'s "0.0.0.0:8080->80/tcp, :::8080->80/tcp"
 *  rendering, in the same "8080→80" shape `formatPorts` produces from compose's
 *  structured `Publishers`, deduped across the IPv4/IPv6 bind of one mapping. */
function portsFromPsString(ports: string | undefined): string | undefined {
    const seen = new Set<string>();
    for (const part of (ports ?? "").split(",")) {
        const m = /:(\d+)->(\d+)/.exec(part.trim());
        if (m) {
            seen.add(`${m[1]}→${m[2]}`);
        }
    }
    return seen.size === 0 ? undefined : [...seen].join(", ");
}

/** `docker ps` scoped to one compose project by label, shaped like the entries
 *  `docker compose ps` would have returned. Only used when the compose CLI
 *  can't run at all — see the call site. */
async function psByProjectLabel(server: HostAgent, project: string): Promise<ComposePsEntry[]> {
    if (!SAFE_ID_RE.test(project)) {
        return [];
    }
    const res = await server.run(["docker", "ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{json .}}"]);
    if (res.code !== 0) {
        return [];
    }
    return parseJsonLines<PsRow>(res.stdout).flatMap((row) => {
        const service = parseLabel(row.Labels, "com.docker.compose.service");
        if (!service) {
            return [];
        }
        return [{
            ID: row.ID,
            Service: service,
            Image: row.Image,
            State: row.State,
            // Ports come back as a rendered string here, not compose's structured
            // Publishers, so they're parsed rather than read off fields.
            PsPorts: portsFromPsString(row.Ports),
        }];
    });
}

/**
 * Merges the compose file's declared services with `docker compose ps`'s view
 * of what's actually running, for the Stacks section's status badge + services
 * table — deliberately simpler than a full running/disk/reconcile merge
 * (doc/idea_stack_registry.md §2): docker's own CLI does the compose-file
 * parsing, so there's no YAML dependency or predicted-name ambiguity to own.
 */
export async function getComposeStackStatus(
    server: HostAgent,
    dir: string,
    composeFile: string,
    project: string,
): Promise<ComposeStackStatus> {
    const { config } = await composeConfig(server, dir, composeFile, project);
    const declared = config ? Object.keys(config.services ?? {}) : [];

    const psRes = await server.run(composeArgv(composeFile, project, "ps", "--format", "json", "--all"), { cwd: dir });
    // Every compose command is run from the stack's directory, so all of them
    // fail to start at all if that directory is gone — which says nothing about whether
    // the containers are still running, and they very often are (a folder
    // deleted out from under a live stack, or a volume that didn't remount).
    // The compose *labels* on the containers survive either way, so fall back to
    // plain `docker ps` and rebuild the service view from those.
    const present = psRes.code === 0
        ? parseJsonLines<ComposePsEntry>(psRes.stdout)
        : await psByProjectLabel(server, project);
    const byService = new Map(present.map((e) => [e.Service, e]));

    // Union of what the compose file declares and what's actually running, in
    // that order. Running-but-undeclared matters more than it sounds: if the
    // compose file can't be read at all — deleted, moved, or unparsable —
    // `declared` is empty, and reporting that as "no services, down" would
    // contradict the containers the host is plainly still running. Falling back
    // to `ps` keeps the answer true to the host.
    const names = [...declared];
    for (const entry of present) {
        if (entry.Service && !names.includes(entry.Service)) {
            names.push(entry.Service);
        }
    }

    const services: ComposeServiceStatus[] = names.map((name) => {
        const entry = byService.get(name);
        return {
            name,
            containerId: entry?.ID,
            image: entry?.Image ?? config?.services?.[name]?.image,
            state: entry?.State,
            ports: entry ? (entry.PsPorts ?? formatPorts(entry)) : undefined,
            up: entry?.State === "running",
        };
    });

    const upCount = services.filter((s) => s.up).length;
    const status: ComposeStackRunStatus =
        services.length === 0 || present.length === 0 ? "down"
            : upCount === 0 ? "stopped"
                : upCount === services.length ? "running"
                    : "partial";

    return { status, services };
}

/** `docker compose logs`, optionally scoped to one service — one-shot, not
 *  streaming (same 30s exec ceiling noted throughout this file's stack-facing
 *  helpers). Compose's own service-name line prefix does the "which service"
 *  labeling; `--no-color` keeps the output plain since the frontend renders
 *  it through the same ANSI-aware LogViewer as everything else, not raw. */
export async function getComposeStackLogs(
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
    const svc = service ? [service] : [];
    // No stream-merging needed here, unlike {@link dockerContainerLogs}: compose
    // demultiplexes its services itself and writes the lot to its own stdout,
    // prefixed with the service name. Its stderr carries compose's own errors
    // and nothing else — which is all the `2>&1` here was ever collecting.
    const res = await server.run(
        composeArgv(composeFile, project, "logs", "--no-color", "--tail", String(Math.max(1, Math.floor(tail))), ...svc),
        { cwd: dir },
    );
    return logOutput(res);
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
    const cmd = CONTAINER_VERBS.get(action);
    if (cmd === undefined) {
        throw new Error(`Unsupported container action: ${action}`);
    }
    const res = await server.run(["docker", ...cmd, containerId]);
    onLog?.(res.stdout);
    if (res.code !== 0) {
        throw new Error(errorText(res) || `docker ${action} failed`);
    }
}

export async function dockerContainerInspect(server: HostAgent, containerId: string): Promise<DockerContainerDetail> {
    if (!SAFE_ID_RE.test(containerId)) {
        throw new Error(`Invalid container id: ${containerId}`);
    }
    const res = await server.run(["docker", "inspect", containerId]);
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
    return server.run(["docker", "exec", containerId, "sh", "-c", command]);
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

/** The `--timestamps` prefix docker puts on each line: RFC3339 with a
 *  fixed-width nanosecond field. Fixed-width is the part that matters — docker
 *  formats it that way (its own `RFC3339NanoFixed`, not Go's variable-width
 *  `RFC3339Nano`) specifically so timestamps compare as strings. */
const LOG_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z) /;

/**
 * Put a container's two log streams back into one chronological sequence.
 *
 * `docker logs` demultiplexes the container's stdout and stderr onto its own
 * two fds, so an argv run receives them as two separate pipes — nginx's access
 * log on one and its error log on the other, no longer interleaved. Sorting by
 * the timestamp docker stamps each line with restores the order, and restores
 * it from data rather than from the arrival order of two pipes: the daemon
 * assigned those timestamps when it read each line, which is as close to the
 * container's own write order as anything downstream can get. Verified against
 * a real container's mixed log: identical, line for line, to what `2>&1` gave.
 *
 * Ties keep stdout ahead of stderr, since the sort is stable and stdout goes in
 * first; a line docker didn't stamp (a continuation) inherits the timestamp
 * above it, so a multi-line entry stays together instead of scattering.
 */
function mergeLogStreams(stdout: string, stderr: string, keepTimestamps: boolean): string {
    const stamped = (text: string): { ts: string; line: string; prefix: number }[] => {
        const lines = text.split("\n");
        // Only the trailing element after the final newline is dropped — a blank
        // line inside the log is a real line (and carries a timestamp of its own).
        if (lines[lines.length - 1] === "") {
            lines.pop();
        }
        let last = "";
        return lines.map((line) => {
            const m = LOG_TIMESTAMP_RE.exec(line);
            if (!m) {
                return { ts: last, line, prefix: 0 };
            }
            last = m[1];
            return { ts: m[1], line, prefix: m[0].length };
        });
    };

    return [...stamped(stdout), ...stamped(stderr)]
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
        .map((l) => (keepTimestamps ? l.line : l.line.slice(l.prefix)))
        .join("\n");
}

export async function dockerContainerLogs(
    server: HostAgent,
    containerId: string,
    opts: LogQuery & { timestamps?: boolean },
): Promise<string> {
    if (!SAFE_ID_RE.test(containerId)) {
        throw new Error(`Invalid container id: ${containerId}`);
    }
    // `--timestamps` unconditionally, even when the caller doesn't want them
    // shown: they're how the two streams get put back in order below, and they're
    // stripped again on the way out. See {@link mergeLogStreams}.
    const args = ["logs", "--timestamps", "--tail", String(Math.floor(opts.limit ?? 500))];
    const since = dockerSince(opts.since);
    if (since) {
        args.push("--since", since);
    }
    const res = await server.run(["docker", ...args, containerId]);
    if (res.code !== 0) {
        return logOutput(res);
    }
    const merged = mergeLogStreams(res.stdout, res.stderr, opts.timestamps === true);
    return opts.order === "newest" ? reverseLines(merged) : merged;
}

export async function dockerVolumeInspect(server: HostAgent, name: string): Promise<DockerVolumeDetail> {
    if (!SAFE_ID_RE.test(name)) {
        throw new Error(`Invalid volume name: ${name}`);
    }
    const [inspect, attached] = await Promise.all([
        server.run(["docker", "volume", "inspect", name]),
        server.run(["docker", "ps", "-a", "--filter", `volume=${name}`, "--format", "{{json .}}"]),
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
    const res = await server.run(["docker", "volume", "rm", name]);
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
    const res = await server.run(["docker", "rmi", imageId]);
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
    const res = await runStreamingLines(server, ["docker", "pull", ref], onLog);
    const message = (res.stdout + res.stderr).trim();
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

const EMPTY_IMAGE_DEFAULTS: ImageDefaults = { present: false, volumes: [], ports: [], env: [] };

/**
 * What an image's Dockerfile already declared — `VOLUME`, `EXPOSE`, `ENV` —
 * read from a single `docker image inspect --format '{{json .Config}}'` call
 * (one exec covers all three, rather than one inspect per field). Cheap: no
 * pull or run, so it only works if the image is already present locally;
 * returns all-empty rather than triggering a pull otherwise (pulls belong to
 * the task system, where they run as a `docker_image_pull` task with a live log).
 */
export async function imageDefaults(server: HostAgent, image: string): Promise<ImageDefaults> {
    if (!SAFE_REF_RE.test(image)) {
        throw new Error(`Invalid image reference: ${image}`);
    }
    const res = await server.run(["docker", "image", "inspect", image, "--format", "{{json .Config}}"]);
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
        return { present: true, volumes, ports, env };
    } catch {
        return EMPTY_IMAGE_DEFAULTS;
    }
}
