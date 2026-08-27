import * as fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMode, ComposeStack, SystemInfo, TaskRun } from "@central/shared";
import type { TrustedProxyEntry } from "./client-ip";
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
const STACK_STATE_FILE = path.join(CONFIG_DIR, "compose-stacks.json");
// Pre-rename name for the same registry, read once on startup so an install
// from before compose stacks were split out of "apps" carries its stacks over.
// (It was never plain "apps.json" — that name belongs to the OIDC client store,
// apps/server/src/features/oidc/store.ts.)
const LEGACY_STACK_STATE_FILE = path.join(CONFIG_DIR, "app-registry.json");

export interface Config {
    /**
     * External hostname **agents** use to reach this control plane: it goes into
     * the node server's TLS leaf as a SAN and becomes the off-LAN endpoint in
     * enrollment commands (`wss://<domain>:4142/node`). Optional; the discovered
     * WAN IP is used when it's unset.
     *
     * Not the address the web UI is served at, which is worth stating because a
     * reverse-proxy setup makes the two look like the same thing. They're only the
     * same when the proxy runs on this host and `:4142` is reachable under the same
     * name; if the proxy is a separate machine, this must stay the name that
     * resolves to *this* host, or agents get an endpoint that doesn't answer.
     * Nothing the browser talks to reads this — see docs/reverse-proxy.md.
     */
    domain?: string;
    /**
     * Address the web/API listener binds to. Unset means every interface, which
     * is right for direct exposure. Behind a TLS-terminating reverse proxy on the
     * same host, set "127.0.0.1" so the plaintext port isn't reachable from the
     * network at all. Read once at startup — changing it needs a restart.
     * `SC_BIND` overrides it, for installs configured by unit file or container
     * env rather than by config.json.
     */
    bindHost?: string;
    /**
     * Reverse proxies this control plane will believe `X-Forwarded-For` from, as
     * bare IPs or CIDRs ("127.0.0.1", "10.42.0.0/16"). Empty/unset means the
     * header is ignored and the direct peer is the client — the correct default
     * for direct exposure, since anyone can send the header.
     *
     * Set this when running behind a proxy: sessions record the real client IP,
     * and the login throttle stops treating the whole company as one address.
     *
     * An entry may be a bare address, or `{ address, header }` naming the header
     * that particular proxy writes — for a control plane reachable through two
     * different front ends at once. Entries without one use `forwardedHeader`.
     *
     * Editable from Settings, and applied live. `SC_TRUSTED_PROXIES` overrides it
     * and makes it read-only there: comma-separated, each entry optionally
     * `address=header` ("127.0.0.1,10.42.0.0/16=X-Real-IP"). See client-ip.ts.
     */
    trustedProxies?: TrustedProxyEntry[];
    /**
     * Which header carries the real client address, when `trustedProxies` says to
     * believe one. Defaults to `X-Forwarded-For`; case-insensitive.
     *
     * Set it to whatever your proxy actually writes — `X-Real-IP` (nginx's
     * single-address convention), `CF-Connecting-IP`, `True-Client-IP`, or
     * `Forwarded` for RFC 7239, which is parsed in its own `for=` syntax rather
     * than as a plain list. Deliberately one header, not a list of candidates to
     * try: falling back to a second header means an address the proxy didn't set
     * can win whenever the expected one is absent.
     *
     * Read once at startup; `SC_FORWARDED_HEADER` overrides it. See client-ip.ts.
     */
    forwardedHeader?: string;
    /**
     * Origins allowed to read API responses cross-origin, as full URLs or bare
     * origins ("https://app.example.com"). The OIDC issuer URL's origin is added
     * implicitly, so a proxied install that has set it needn't repeat the hostname.
     *
     * Unset (or containing "*") keeps the historical `Access-Control-Allow-Origin: *`.
     * The web UI is same-origin and needs none of this. Read once at startup;
     * `SC_ALLOWED_ORIGINS` (comma-separated) overrides it. See cors.ts — and note it
     * governs reading responses, not whether a request is delivered.
     */
    allowedOrigins?: string[];
    /**
     * The canonical public URL browsers reach this control plane at, e.g.
     * "https://central.example.com" — one value for "where does SC live", rather
     * than the same hostname retyped per feature.
     *
     * It is the OIDC `iss` claim and discovery-document base, and is what future
     * link-generating features (emails, third-party integrations) should use. Set
     * explicitly rather than derived per-request, because `iss` must stay stable
     * once an OIDC client trusts it — hence the guard on changing it while clients
     * exist (features/settings/feature.ts).
     *
     * Distinct from {@link Config.domain}, which is the agents' address, and from
     * {@link Config.allowedOrigins}, which is about *other* origins calling the API.
     */
    primaryUrl?: string;
    /**
     * Pre-rename name for {@link Config.primaryUrl}, read once as a fallback so an
     * install configured before the rename keeps working. Left in place on write
     * rather than deleted, so downgrading isn't a data-loss event — the same
     * approach as the compose-stack registry's legacy file below.
     *
     * @deprecated Use primaryUrl.
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
        const config = JSON.parse(text) as Config;
        // Carry a pre-rename issuerUrl forward, so every caller can just read
        // primaryUrl without each one remembering the old name.
        if (!config.primaryUrl && config.issuerUrl) {
            config.primaryUrl = config.issuerUrl;
        }
        return config;
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

export async function setPrimaryUrl(primaryUrl: string | null): Promise<void> {
    const current = await readConfig();
    if (primaryUrl) {
        current.primaryUrl = primaryUrl.replace(/\/+$/, "");
    } else {
        delete current.primaryUrl;
    }
    // The legacy key would otherwise be resurrected by readConfig's fallback on the
    // next load, silently undoing a clear or an edit.
    delete current.issuerUrl;
    await writeConfig(current);
}

export async function setTrustedProxies(trustedProxies: TrustedProxyEntry[]): Promise<void> {
    const current = await readConfig();
    if (trustedProxies.length > 0) {
        current.trustedProxies = trustedProxies;
    } else {
        delete current.trustedProxies;
    }
    await writeConfig(current);
}

export async function setAllowedOrigins(allowedOrigins: string[]): Promise<void> {
    const current = await readConfig();
    if (allowedOrigins.length > 0) {
        current.allowedOrigins = allowedOrigins;
    } else {
        delete current.allowedOrigins;
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

/** Persisted registry of SC-managed compose stacks — the control plane's list
 *  of known stack directories across the fleet, keyed by stack id. See
 *  ComposeStackStore (apps/server/src/features/compose/store.ts). Falls back to
 *  the pre-rename file, which the next write then supersedes; the old file is
 *  left in place rather than deleted, so downgrading isn't a data-loss event. */
export async function readComposeStackState(): Promise<Record<string, ComposeStack>> {
    for (const file of [STACK_STATE_FILE, LEGACY_STACK_STATE_FILE]) {
        try {
            return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, ComposeStack>;
        } catch { /* absent or unparsable — try the next candidate */ }
    }
    return {};
}

export async function writeComposeStackState(stacks: Record<string, ComposeStack>): Promise<void> {
    await ensureDir();
    await writeFileAtomic(STACK_STATE_FILE, JSON.stringify(stacks, null, 2));
}
