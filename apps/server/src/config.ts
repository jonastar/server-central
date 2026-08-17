import * as fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMode, App, SystemInfo, TaskRun } from "@central/shared";
import { writeFileAtomic } from "./fs-atomic";

/**
 * Where config, TLS, tokens, and the agent-binary cache live. Relative ".sc-data"
 * in dev (resolved against cwd); an installed control plane sets SC_DATA_DIR to an
 * absolute path (e.g. /var/lib/sc-central) via its systemd unit.
 *
 * Under `bun test` the relative default is never acceptable: it resolves against
 * cwd, and tests chdir into throwaway dirs while fire-and-forget writes are still
 * in flight — which is how a test run once clobbered a live dev instance's
 * agents.json. `test/env-preload.ts` normally pins SC_DATA_DIR, but bunfig (and so
 * the preload) is only discovered when `bun test` runs from apps/server, leaving
 * a repo-root `bun test` unprotected. Bun sets NODE_ENV=test, so this backstop
 * holds regardless of how the runner was invoked.
 */
function defaultDataDir(): string {
    if (process.env.NODE_ENV === "test") {
        return mkdtempSync(path.join(os.tmpdir(), "sc-test-data-"));
    }
    return ".sc-data";
}

export const CONFIG_DIR = process.env.SC_DATA_DIR || defaultDataDir();
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const AGENT_STATE_FILE = path.join(CONFIG_DIR, "agents.json");
const AGENT_TOKENS_FILE = path.join(CONFIG_DIR, "agent-tokens.json");
const TASK_STATE_FILE = path.join(CONFIG_DIR, "tasks.json");
// Deliberately not "apps.json" — that file already belongs to the OIDC client
// store (apps/server/src/oidc/store.ts), a same-directory naming collision left
// over from when OIDC clients were briefly called "apps".
const APP_STATE_FILE = path.join(CONFIG_DIR, "app-registry.json");

export interface Config {
    domain?: string;
    /**
     * Absolute base URL (e.g. "https://central.example.com") used as the OIDC
     * `iss` claim and discovery-document base. Must stay stable once any OIDC
     * client trusts it, so it's set explicitly rather than derived per-request.
     */
    issuerUrl?: string;
    /**
     * Where the control plane backfills agent binaries it doesn't already have
     * locally (cache or dist/). Defaults to this repo's GitHub Releases; override
     * baseUrl for a self-hosted/custom mirror, and set token for an authenticated
     * source. See binary-store.ts.
     */
    releaseSource?: {
        baseUrl?: string;
        token?: string;
        /** Endpoint returning the latest release `tag_name` (for the control plane's
         *  own update check). Defaults to the GitHub releases/latest API derived from
         *  a github.com baseUrl; set explicitly for a custom mirror. */
        latestUrl?: string;
    };
}

/** Persisted record for a known agent, kept across server restarts. */
export interface AgentRecord {
    id: string;
    name: string;
    info?: SystemInfo;
    /** Mode of the agent when last seen; absent for records written before modes existed. */
    mode?: AgentMode;
    lastSeenAt: number;
}

async function ensureDir(): Promise<void> {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
}

// Re-exported so the many `import { CONFIG_DIR, writeFileAtomic } from "./config"`
// call sites keep working; the implementation lives in fs-atomic.ts alongside the
// sweeper that cleans up after it.
export { writeFileAtomic };

export async function readConfig(): Promise<Config> {
    try {
        const text = await fs.readFile(CONFIG_FILE, "utf8");
        return JSON.parse(text) as Config;
    } catch {
        return {};
    }
}

export async function writeConfig(config: Config): Promise<void> {
    await ensureDir();
    await writeFileAtomic(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export async function setDomain(domain: string | null): Promise<void> {
    const current = await readConfig();
    if (domain) {
        current.domain = domain;
    } else {
        delete current.domain;
    }
    await writeConfig(current);
}

export async function setIssuerUrl(issuerUrl: string | null): Promise<void> {
    const current = await readConfig();
    if (issuerUrl) {
        current.issuerUrl = issuerUrl.replace(/\/+$/, "");
    } else {
        delete current.issuerUrl;
    }
    await writeConfig(current);
}

export async function readAgentState(): Promise<Record<string, AgentRecord>> {
    try {
        const text = await fs.readFile(AGENT_STATE_FILE, "utf8");
        return JSON.parse(text) as Record<string, AgentRecord>;
    } catch {
        return {};
    }
}

export async function writeAgentState(agents: Record<string, AgentRecord>): Promise<void> {
    await ensureDir();
    await writeFileAtomic(AGENT_STATE_FILE, JSON.stringify(agents, null, 2));
}

/**
 * Durable per-machine agent tokens (machineId → token). Issued when a live agent
 * is promoted to an installed service; the systemd unit uses one to reconnect
 * indefinitely, since short-lived enrollment tokens would expire.
 */
export async function readAgentTokens(): Promise<Record<string, string>> {
    try {
        const text = await fs.readFile(AGENT_TOKENS_FILE, "utf8");
        return JSON.parse(text) as Record<string, string>;
    } catch {
        return {};
    }
}

export async function writeAgentTokens(tokens: Record<string, string>): Promise<void> {
    await ensureDir();
    await writeFileAtomic(AGENT_TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

/**
 * Persisted task runs, newest last. The store caps how many it keeps before
 * writing, so this file stays bounded.
 */
export async function readTaskState(): Promise<TaskRun[]> {
    try {
        const text = await fs.readFile(TASK_STATE_FILE, "utf8");
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? (parsed as TaskRun[]) : [];
    } catch {
        return [];
    }
}

export async function writeTaskState(runs: TaskRun[]): Promise<void> {
    await ensureDir();
    await writeFileAtomic(TASK_STATE_FILE, JSON.stringify(runs, null, 2));
}

/** Persisted App registry — the control plane's list of known App directories
 *  across the fleet. See AppStore (apps/server/src/apps.ts). */
export async function readAppState(): Promise<Record<string, App>> {
    try {
        const text = await fs.readFile(APP_STATE_FILE, "utf8");
        return JSON.parse(text) as Record<string, App>;
    } catch {
        return {};
    }
}

export async function writeAppState(apps: Record<string, App>): Promise<void> {
    await ensureDir();
    await writeFileAtomic(APP_STATE_FILE, JSON.stringify(apps, null, 2));
}
