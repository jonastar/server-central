import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { AgentMode, SystemInfo, TaskRun } from "@central/shared";

// State dir for config, TLS, tokens, and the agent-binary cache. Relative ".sc-data"
// in dev (resolved against cwd); an installed control plane sets SC_DATA_DIR to an
// absolute path (e.g. /var/lib/sc-central) via its systemd unit.
export const CONFIG_DIR = process.env.SC_DATA_DIR || ".sc-data";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const AGENT_STATE_FILE = path.join(CONFIG_DIR, "agents.json");
const AGENT_TOKENS_FILE = path.join(CONFIG_DIR, "agent-tokens.json");
const TASK_STATE_FILE = path.join(CONFIG_DIR, "tasks.json");

export interface Config {
    domain?: string;
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

/**
 * Write a file atomically: write to a temp sibling, then rename over the target.
 * rename(2) is atomic within a filesystem, so a crash mid-write leaves the old
 * file intact rather than a truncated one — important for the user/session/token
 * stores, where a corrupt file would lock everyone out or orphan every agent.
 */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, file);
}

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
