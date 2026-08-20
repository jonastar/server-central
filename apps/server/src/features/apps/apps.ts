import { randomUUID } from "node:crypto";
import type { App, AppDetection } from "@central/shared";
import type { Fleet } from "../../fleet";
import { readAppState, writeAppState } from "../../config";
import { composeConfig } from "../docker/docker";

const COMPOSE_CANDIDATES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

/** Compose's own default project-name rule: the lowercased/sanitized basename
 *  of the directory. Only a prediction — the operator can rename on create/import. */
function predictProjectName(dir: string): string {
    const base = dir.split("/").filter(Boolean).pop() ?? "app";
    const slug = base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
    return slug || "app";
}

function joinDir(dir: string, name: string): string {
    return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function manifestJson(app: App): string {
    return JSON.stringify({ id: app.id, name: app.name, composeFile: app.composeFile, createdAt: app.createdAt }, null, 2);
}

/**
 * Registry of Apps — directories on a host containing `sc-app.json` +
 * a compose file + `volumes/`. See doc/idea_app_system.md. Fleet-shaped:
 * in-memory, persisted on every change, one flat list across every host (a
 * host being offline just means its Apps show unreachable, same as any other
 * host-scoped view today).
 */
export class AppStore {
    private apps = new Map<string, App>();

    constructor(private readonly fleet: Fleet) { }

    async init(): Promise<void> {
        const stored = await readAppState();
        for (const app of Object.values(stored)) {
            this.apps.set(app.id, app);
        }
    }

    list(): App[] {
        return [...this.apps.values()];
    }

    get(id: string): App {
        const app = this.apps.get(id);
        if (!app) {
            throw new Error(`Unknown app: ${id}`);
        }
        return app;
    }

    private async persist(): Promise<void> {
        await writeAppState(Object.fromEntries(this.apps));
    }

    /** Scaffolds a fresh App directory: `sc-app.json` + an empty `compose.yaml` + `volumes/`. */
    async create(name: string, hostId: string, dir: string): Promise<App> {
        const trimmed = name.trim();
        if (!trimmed) {
            throw new Error("App name is required");
        }
        const agent = this.fleet.get(hostId);
        const app: App = {
            id: randomUUID(),
            name: trimmed,
            hostId,
            dir,
            composeFile: "compose.yaml",
            project: predictProjectName(dir),
            createdAt: Date.now(),
        };
        await agent.createDir(dir);
        await agent.createDir(joinDir(dir, "volumes"));
        await agent.writeFile(joinDir(dir, app.composeFile), "services:\n");
        await agent.writeFile(joinDir(dir, "sc-app.json"), manifestJson(app));
        this.apps.set(app.id, app);
        await this.persist();
        return app;
    }

    /** Probes a candidate directory before import — whether it has a compose
     *  file/manifest, its declared services, and any bind mounts pointing
     *  outside the directory (which stay where they are on import). */
    async detect(hostId: string, dir: string): Promise<AppDetection> {
        const agent = this.fleet.get(hostId);
        const predictedName = predictProjectName(dir);

        let manifestFound = false;
        try {
            await agent.readFile(joinDir(dir, "sc-app.json"));
            manifestFound = true;
        } catch { /* absent, or unreadable — treated the same as absent */ }

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
     *  overwrites `sc-app.json`, even when one already exists — two SC
     *  installations must never share an app id (doc/idea_app_system.md §5). */
    async import(hostId: string, dir: string, name: string): Promise<App> {
        const trimmed = name.trim();
        if (!trimmed) {
            throw new Error("App name is required");
        }
        const agent = this.fleet.get(hostId);
        const { entries } = await agent.listDir(dir);
        const names = new Set(entries.map((e) => e.name));
        const composeFile = COMPOSE_CANDIDATES.find((c) => names.has(c));
        if (!composeFile) {
            throw new Error(`No compose file found in ${dir}`);
        }
        const app: App = {
            id: randomUUID(),
            name: trimmed,
            hostId,
            dir,
            composeFile,
            project: predictProjectName(dir),
            createdAt: Date.now(),
        };
        await agent.writeFile(joinDir(dir, "sc-app.json"), manifestJson(app));
        this.apps.set(app.id, app);
        await this.persist();
        return app;
    }

    /** Unregisters the app. With `deleteDir`, also removes its directory (compose
     *  file, manifest, and volumes/) from the host — best-effort, since an
     *  offline host shouldn't block forgetting the app either. */
    async delete(id: string, deleteDir: boolean): Promise<void> {
        const app = this.get(id);
        if (deleteDir) {
            try {
                await this.fleet.get(app.hostId).deletePath(app.dir);
            } catch { /* host offline or dir already gone — unregister regardless */ }
        }
        this.apps.delete(id);
        await this.persist();
    }
}
