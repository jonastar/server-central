import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SystemInfo } from "@central/shared";

export const CONFIG_DIR = ".sc-data";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const AGENT_STATE_FILE = path.join(CONFIG_DIR, "agents.json");

export interface Config {
    domain?: string;
}

/** Persisted record for a known agent, kept across server restarts. */
export interface AgentRecord {
    id: string;
    name: string;
    info?: SystemInfo;
    lastSeenAt: number;
}

async function ensureDir(): Promise<void> {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
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
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
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
    await fs.writeFile(AGENT_STATE_FILE, JSON.stringify(agents, null, 2));
}
