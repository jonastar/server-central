import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { AGENT_VERSION } from "@central/shared";
import { CONFIG_DIR, readConfig } from "./config";

// The control plane serves agent binaries to enrolling/updating agents, but it only
// needs its *own* platform binary to run. Rather than ship every platform up front,
// it resolves a requested binary lazily: local cache first, then a dev/custom build
// in dist/, then (on a miss) download it from the release source, verify its
// checksum, and cache it. Agents always download from the control plane — this just
// backfills what the control plane doesn't have, so testing, air-gapped operation,
// and custom builds (drop into dist/ or the cache) all keep working.

/** Dist directory relative to the server package root (dev/custom builds). */
const DIST_DIR = path.resolve(import.meta.dir, "../../../dist");
/** Local cache of binaries backfilled from the release source. */
const CACHE_DIR = path.join(CONFIG_DIR, "agent-binaries");

/** Default release source: this repo's public GitHub Releases download endpoint.
 *  Assets live at `<baseUrl>/v<version>/<asset>` alongside a `SHA256SUMS` file. */
const DEFAULT_RELEASE_BASE_URL = "https://github.com/jonastar/server-central/releases/download";

/** Per-attempt download deadline. Binaries are tens of MB but transfer in seconds on
 *  any real link, so this only bites an unreachable/slow source. */
const DOWNLOAD_TIMEOUT_MS = 30_000;

export const SUPPORTED_PLATFORMS = ["linux-x64", "mac-x64", "windows-x64"] as const;
export type Platform = (typeof SUPPORTED_PLATFORMS)[number];

/** Thrown with an HTTP status so the node-server route can map it to a response. */
export class BinaryStoreError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
        this.name = "BinaryStoreError";
    }
}

/** Legacy platform names from older agents, mapped to their current equivalent.
 *  Pre-x64 builds reported a bare arch-less "linux"; keep enrolling them working. */
const LEGACY_PLATFORM_ALIASES: Record<string, Platform> = {
    linux: "linux-x64",
    mac: "mac-x64",
    windows: "windows-x64",
};

/** Map a legacy platform name to its current equivalent (pass-through otherwise). */
function normalizePlatform(platform: string): string {
    return LEGACY_PLATFORM_ALIASES[platform] ?? platform;
}

function isSupported(platform: string): platform is Platform {
    return (SUPPORTED_PLATFORMS as readonly string[]).includes(platform);
}

/** The dist/release asset name for a platform (windows carries .exe). */
function assetName(platform: Platform): string {
    return platform.startsWith("windows") ? `sc-agent-${platform}.exe` : `sc-agent-${platform}`;
}

/** The versioned cache file name, so multiple versions can coexist (rollback/staging). */
function cacheName(platform: Platform, version: string): string {
    return platform.startsWith("windows")
        ? `sc-agent-${platform}-${version}.exe`
        : `sc-agent-${platform}-${version}`;
}

async function fileExists(p: string): Promise<boolean> {
    return Bun.file(p).exists();
}

// De-dupe concurrent backfills: two agents of the same platform enrolling at once
// should trigger a single download, not a race that writes the file twice.
const inflight = new Map<string, Promise<string>>();

/**
 * Resolve the agent binary for `platform` (default version = the control plane's own
 * AGENT_VERSION, so agents stay in lockstep with the control plane). Returns the
 * absolute path to a ready-to-serve file. Throws BinaryStoreError on unsupported
 * platforms or an unreachable/invalid release source.
 */
export async function resolveAgentBinary(platform: string, version: string = AGENT_VERSION): Promise<string> {
    platform = normalizePlatform(platform);
    if (!isSupported(platform)) {
        throw new BinaryStoreError(`Unsupported platform: ${platform}`, 400);
    }

    // 1. Versioned cache (previously backfilled).
    const cached = path.join(CACHE_DIR, cacheName(platform, version));
    if (await fileExists(cached)) {
        return cached;
    }

    // 2. Local dist/ (dev + custom builds), treated as the current version. Kept
    //    ahead of the release source so a local `build:agent` is served as-is and
    //    the dev/test loop never hits the network.
    const distPath = path.join(DIST_DIR, assetName(platform));
    if (await fileExists(distPath)) {
        return distPath;
    }

    // 3. Backfill from the release source (single flight per platform+version).
    const key = `${platform}@${version}`;
    let pending = inflight.get(key);
    if (!pending) {
        pending = (async () => {
            await fs.mkdir(CACHE_DIR, { recursive: true });
            return downloadVerifiedBinary(platform, version, cached);
        })().finally(() => inflight.delete(key));
        inflight.set(key, pending);
    }
    return pending;
}

/**
 * Download `platform`@`version` from the release source, verify its checksum, and
 * write it (executable) to `dest` via a temp+rename. Fails closed if the checksum is
 * missing or mismatches — the control plane hands these to root-running agents (and
 * its own self-update binary), so an unverified binary is RCE. Used both to backfill
 * the cache and to fetch the control plane's own self-update binary.
 */
export async function downloadVerifiedBinary(platform: string, version: string, dest: string): Promise<string> {
    platform = normalizePlatform(platform);
    if (!isSupported(platform)) {
        throw new BinaryStoreError(`Unsupported platform: ${platform}`, 400);
    }
    const cfg = (await readConfig()).releaseSource ?? {};
    const baseUrl = (cfg.baseUrl ?? DEFAULT_RELEASE_BASE_URL).replace(/\/$/, "");
    const tagBase = `${baseUrl}/v${version}`;
    const asset = assetName(platform);

    console.log(`[binary-store] downloading ${asset} (v${version}) from ${tagBase}`);
    const [binary, sums] = await Promise.all([
        download(`${tagBase}/${asset}`, cfg.token),
        download(`${tagBase}/SHA256SUMS`, cfg.token),
    ]);

    const expected = parseChecksums(new TextDecoder().decode(sums)).get(asset);
    if (!expected) {
        throw new BinaryStoreError(`No SHA256SUMS entry for ${asset} in release v${version}`, 502);
    }
    const actual = createHash("sha256").update(binary).digest("hex");
    if (actual !== expected) {
        throw new BinaryStoreError(`Checksum mismatch for ${asset} (expected ${expected}, got ${actual})`, 502);
    }

    const tmp = `${dest}.download-${process.pid}`;
    await Bun.write(tmp, binary);
    await fs.chmod(tmp, 0o755);
    await fs.rename(tmp, dest);
    console.log(`[binary-store] wrote ${asset} → ${dest} (${binary.byteLength} bytes, verified)`);
    return dest;
}

let latestCache: { version: string; at: number } | null = null;
const LATEST_TTL_MS = 10 * 60 * 1000;

/**
 * The latest available release version (for the control plane's own update check).
 * For a GitHub download base it queries the public releases/latest API; a custom
 * mirror can set releaseSource.latestUrl. Cached briefly so UI polling doesn't hammer
 * the API (anonymous GitHub is rate-limited to 60/hr).
 */
export async function getLatestVersion(): Promise<string> {
    if (latestCache && Date.now() - latestCache.at < LATEST_TTL_MS) {
        return latestCache.version;
    }
    const cfg = (await readConfig()).releaseSource ?? {};
    const url = cfg.latestUrl ?? deriveLatestUrl(cfg.baseUrl ?? DEFAULT_RELEASE_BASE_URL);
    if (!url) {
        throw new BinaryStoreError("No latest-release URL configured (set releaseSource.latestUrl)", 502);
    }
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "server-central" };
    if (cfg.token) {
        headers["Authorization"] = `Bearer ${cfg.token}`;
    }
    let res: Response;
    try {
        res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
        throw new BinaryStoreError(`Latest-release check failed: ${(err as Error).message}`, 502);
    }
    if (!res.ok) {
        throw new BinaryStoreError(`Latest-release check HTTP ${res.status}`, 502);
    }
    const tag = ((await res.json()) as { tag_name?: string }).tag_name;
    if (!tag) {
        throw new BinaryStoreError("Latest release has no tag_name", 502);
    }
    const version = tag.replace(/^v/, "");
    latestCache = { version, at: Date.now() };
    return version;
}

/** Derive the GitHub releases/latest API URL from a `…/<owner>/<repo>/releases/download` base. */
function deriveLatestUrl(baseUrl: string): string | null {
    const m = baseUrl.replace(/\/$/, "").match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download$/);
    return m ? `https://api.github.com/repos/${m[1]}/${m[2]}/releases/latest` : null;
}

async function download(url: string, token: string | undefined): Promise<Uint8Array> {
    const headers: Record<string, string> = {};
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    let res: Response;
    try {
        res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (err) {
        throw new BinaryStoreError(`Fetch failed for ${url}: ${(err as Error).message}`, 502);
    }
    if (!res.ok) {
        throw new BinaryStoreError(`HTTP ${res.status} fetching ${url}`, res.status === 404 ? 404 : 502);
    }
    return new Uint8Array(await res.arrayBuffer());
}

/** Parse `sha256sum` output: `<hex>  <filename>` per line → filename → hex. */
function parseChecksums(text: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const line of text.split("\n")) {
        const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
        if (match) {
            map.set(match[2].trim(), match[1].toLowerCase());
        }
    }
    return map;
}
