import { randomUUID } from "node:crypto";
import type { ComposeStack, ComposeStackDetection, DockerStack } from "@central/shared";
import type { Fleet } from "../../fleet";
import { readComposeStackState, writeComposeStackState } from "../../config";
import { composeConfig } from "../docker/docker";

const COMPOSE_CANDIDATES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

/** SC's own metadata file inside a managed stack directory. `sc-app.json` is
 *  the pre-rename name, still read on detect/import so directories created by
 *  earlier builds adopt cleanly; it's replaced with the current name on import. */
const MANIFEST = "sc-stack.json";
const LEGACY_MANIFEST = "sc-app.json";

/** Compose's own default project-name rule: the lowercased/sanitized basename
 *  of the directory. Only a prediction — the operator can rename on create/import. */
function predictProjectName(dir: string): string {
    const base = dir.split("/").filter(Boolean).pop() ?? "stack";
    const slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
    return slug || "stack";
}

function joinDir(dir: string, name: string): string {
    return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** Split a compose project's `config_files` label into a directory + filename.
 *  The label is a comma-separated list (compose supports several `-f` files);
 *  only the first is the project's own root, which is what a stack record needs.
 *  Null for a relative or empty path — compose usually records an absolute one,
 *  and a relative path has no meaning without the CWD the project was started
 *  from, which isn't recoverable after the fact. */
function parseConfigFiles(configFiles: string): { dir: string; composeFile: string } | null {
    const first = configFiles.split(",")[0]?.trim() ?? "";
    if (!first.startsWith("/")) {
        return null;
    }
    const cut = first.lastIndexOf("/");
    const dir = first.slice(0, cut);
    const composeFile = first.slice(cut + 1);
    return dir && composeFile ? { dir, composeFile } : null;
}

function manifestJson(stack: ComposeStack): string {
    return JSON.stringify({ id: stack.id, name: stack.name, composeFile: stack.composeFile, createdAt: stack.createdAt }, null, 2);
}

/**
 * Registry of SC-managed compose stacks — a directory on a host with a compose
 * file in it. See doc/idea_app_system.md.
 * Fleet-shaped: in-memory, persisted on every change, one flat list across
 * every host (a host being offline just means its stacks show unreachable,
 * same as any other host-scoped view today).
 *
 * Distinct from the label-derived `DockerStack` the Docker tab also shows: this
 * is what SC *registered*, that is what's *observed running*. The Stacks
 * section merges the two.
 */
export class ComposeStackStore {
    private stacks = new Map<string, ComposeStack>();

    constructor(private readonly fleet: Fleet) { }

    async init(): Promise<void> {
        const stored = await readComposeStackState();
        for (const stack of Object.values(stored)) {
            this.stacks.set(stack.id, stack);
        }
    }

    list(): ComposeStack[] {
        return [...this.stacks.values()];
    }

    get(id: string): ComposeStack {
        const stack = this.stacks.get(id);
        if (!stack) {
            throw new Error(`Unknown compose stack: ${id}`);
        }
        return stack;
    }

    private async persist(): Promise<void> {
        await writeComposeStackState(Object.fromEntries(this.stacks));
    }

    /** Scaffolds a fresh stack directory: `sc-stack.json` + a `compose.yaml`.
     *  `content` seeds that file (pasted YAML); without it, it's the bare
     *  `services:` an empty stack starts from. The content isn't validated here —
     *  the stack view's editor validates against `docker compose config`, and
     *  refusing to create the directory would leave the operator with nowhere to
     *  fix a paste that's nearly right.
     *  No volumes/ subdirectory — bind mounts go wherever the compose file says,
     *  and an empty folder SC invented was only ever a convention to explain. */
    async create(name: string, hostId: string, dir: string, content?: string): Promise<ComposeStack> {
        const trimmed = name.trim();
        if (!trimmed) {
            throw new Error("Stack name is required");
        }
        const agent = this.fleet.get(hostId);
        const stack: ComposeStack = {
            id: randomUUID(),
            name: trimmed,
            hostId,
            dir,
            composeFile: "compose.yaml",
            project: predictProjectName(dir),
            createdAt: Date.now(),
        };
        await agent.createDir(dir);
        const composeContent = content?.trim() ? `${content.replace(/\s+$/, "")}\n` : "services:\n";
        await agent.writeFile(joinDir(dir, stack.composeFile), composeContent);
        await agent.writeFile(joinDir(dir, MANIFEST), manifestJson(stack));
        this.stacks.set(stack.id, stack);
        await this.persist();
        return stack;
    }

    /** Probes a candidate directory before import — whether it has a compose
     *  file/manifest, its declared services, and any bind mounts pointing
     *  outside the directory (which stay where they are on import). */
    async detect(hostId: string, dir: string): Promise<ComposeStackDetection> {
        const agent = this.fleet.get(hostId);
        const predictedName = predictProjectName(dir);

        let manifestFound = false;
        for (const candidate of [MANIFEST, LEGACY_MANIFEST]) {
            try {
                await agent.readFile(joinDir(dir, candidate));
                manifestFound = true;
                break;
            } catch { /* absent, or unreadable — treated the same as absent */ }
        }

        const { entries } = await agent.listDir(dir);
        const names = new Set(entries.map((e) => e.name));
        const composeFile = COMPOSE_CANDIDATES.find((c) => names.has(c)) ?? null;

        let services: string[] = [];
        let composeError: string | undefined;
        const externalBindMounts: { source: string; target: string }[] = [];
        let namedVolumeCount = 0;
        if (composeFile) {
            const { config, error } = await composeConfig(agent, dir, composeFile, predictedName);
            if (config) {
                services = Object.keys(config.services ?? {});
                const prefix = dir.endsWith("/") ? dir : `${dir}/`;
                for (const svc of Object.values(config.services ?? {})) {
                    for (const vol of svc.volumes ?? []) {
                        if (vol.type === "bind" && vol.source && vol.target && vol.source !== dir && !vol.source.startsWith(prefix)) {
                            externalBindMounts.push({ source: vol.source, target: vol.target });
                        }
                    }
                }
                namedVolumeCount = Object.keys(config.volumes ?? {}).length;
            } else {
                composeError = error;
            }
        }

        return { composeFound: composeFile !== null, manifestFound, predictedName, services, composeError, externalBindMounts, namedVolumeCount };
    }

    /** Adopts an existing on-disk compose project. Always mints a fresh id and
     *  overwrites the manifest, even when one already exists — two SC
     *  installations must never share a stack id (doc/idea_app_system.md §5). */
    async import(hostId: string, dir: string, name: string): Promise<ComposeStack> {
        const trimmed = name.trim();
        if (!trimmed) {
            throw new Error("Stack name is required");
        }
        const agent = this.fleet.get(hostId);
        const { entries } = await agent.listDir(dir);
        const names = new Set(entries.map((e) => e.name));
        const composeFile = COMPOSE_CANDIDATES.find((c) => names.has(c));
        if (!composeFile) {
            throw new Error(`No compose file found in ${dir}`);
        }
        const stack: ComposeStack = {
            id: randomUUID(),
            name: trimmed,
            hostId,
            dir,
            composeFile,
            project: predictProjectName(dir),
            createdAt: Date.now(),
        };
        await agent.writeFile(joinDir(dir, MANIFEST), manifestJson(stack));
        if (names.has(LEGACY_MANIFEST)) {
            // Don't leave the directory carrying two manifests that disagree.
            try {
                await agent.deletePath(joinDir(dir, LEGACY_MANIFEST));
            } catch { /* best-effort — a stale legacy manifest is cosmetic, not load-bearing */ }
        }
        this.stacks.set(stack.id, stack);
        await this.persist();
        return stack;
    }

    /** Registers a compose project SC is watching run but has no record of.
     *
     *  `project` comes from the container label, never from the directory-basename
     *  prediction `create`/`import` use: an adopted stack's project name is
     *  already fixed by its running containers, and guessing a different one
     *  would make every subsequent action target a project that doesn't exist.
     *  Nothing is written to the host — adoption is a control-plane record only. */
    private adopt(hostId: string, dir: string, composeFile: string, project: string): ComposeStack {
        const stack: ComposeStack = {
            id: randomUUID(),
            name: project,
            hostId,
            dir,
            composeFile,
            project,
            createdAt: Date.now(),
        };
        this.stacks.set(stack.id, stack);
        return stack;
    }

    /**
     * Reconciles one host's registered stacks against what's actually running,
     * adopting anything unregistered that carries a usable compose path. Called
     * on every read of the host's stacks section — it's a map lookup per project
     * and a persist only when something was actually adopted.
     */
    async syncHost(hostId: string, observed: DockerStack[]): Promise<ComposeStack[]> {
        const known = new Set(this.list().filter((s) => s.hostId === hostId).map((s) => s.project));
        let adopted = false;
        for (const obs of observed) {
            if (known.has(obs.project)) {
                continue;
            }
            const loc = parseConfigFiles(obs.configFiles);
            if (!loc) {
                continue;   // no compose path to point a record at; stays unmanaged
            }
            this.adopt(hostId, loc.dir, loc.composeFile, obs.project);
            known.add(obs.project);
            adopted = true;
        }
        if (adopted) {
            await this.persist();
        }
        return this.list().filter((s) => s.hostId === hostId);
    }

    /** Unregisters the stack. With `deleteDir`, also removes its directory
     *  (compose file, manifest, and everything else in it) from the host —
     *  best-effort, since an offline host shouldn't block forgetting the stack
     *  either. */
    async delete(id: string, deleteDir: boolean): Promise<void> {
        const stack = this.get(id);
        if (deleteDir) {
            try {
                await this.fleet.get(stack.hostId).deletePath(stack.dir);
            } catch { /* host offline or dir already gone — unregister regardless */ }
        }
        this.stacks.delete(id);
        await this.persist();
    }
}
