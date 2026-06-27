import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AGENT_VERSION } from "@central/shared";
import { BinaryStoreError, getLatestVersion, resolveAgentBinary } from "../../src/binary-store";

// The binary store resolves an agent binary in order: local cache → dist/ → release
// source (download + checksum-verify + cache). These drive that against a fake
// release source and assert the order, the integrity check, and the failure modes.

const DIST_DIR = path.resolve(import.meta.dir, "../../../../dist");
const DIST_FILES = ["sc-agent-linux-x64", "sc-agent-mac-x64", "sc-agent-windows-x64.exe"];

// A binary served by the fake release source, keyed by asset name.
const served = new Map<string, Uint8Array>();
let release: ReturnType<typeof Bun.serve>;
let baseUrl: string;

// Empty dist/ for the suite so resolution falls through to the release source; the
// precedence test plants a dist file explicitly. Real dev builds are set aside.
const backups: string[] = [];

function sha256(bytes: Uint8Array): string {
    return crypto.createHash("sha256").update(bytes).digest("hex");
}

beforeAll(async () => {
    await fs.mkdir(DIST_DIR, { recursive: true });
    for (const name of DIST_FILES) {
        const full = path.join(DIST_DIR, name);
        if (await Bun.file(full).exists()) {
            await fs.rename(full, `${full}.bstore-backup`);
            backups.push(full);
        }
    }

    release = Bun.serve({
        port: 0,
        fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === "/latest") {
                return Response.json({ tag_name: "v9.9.9" });
            }
            // /dl/v<version>/<asset>  and  /dl/v<version>/SHA256SUMS
            const m = url.pathname.match(/^\/dl\/v[^/]+\/(.+)$/);
            if (!m) {
                return new Response("not found", { status: 404 });
            }
            const name = m[1];
            if (name === "SHA256SUMS") {
                const lines = [...served].map(([asset, bytes]) => `${sha256(bytes)}  ${asset}`).join("\n");
                return new Response(`${lines}\n`);
            }
            const bytes = served.get(name);
            return bytes ? new Response(bytes as unknown as BodyInit) : new Response("not found", { status: 404 });
        },
    });
    baseUrl = `http://127.0.0.1:${release.port}/dl`;
});

afterAll(async () => {
    release.stop(true);
    for (const full of backups) {
        await fs.rename(`${full}.bstore-backup`, full);
    }
});

let tmpDir: string;
let prevCwd: string;

beforeEach(async () => {
    served.clear();
    prevCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-bstore-"));
    process.chdir(tmpDir);
    // Point the store's release source at the fake server (read from .sc-data/config.json).
    await fs.mkdir(".sc-data", { recursive: true });
    await fs.writeFile(".sc-data/config.json", JSON.stringify({ releaseSource: { baseUrl } }));
});

afterEach(async () => {
    process.chdir(prevCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
});

test("backfills from the release source, verifies the checksum, and caches", async () => {
    const bytes = crypto.randomBytes(64 * 1024);
    served.set("sc-agent-mac-x64", bytes);

    const resolved = await resolveAgentBinary("mac-x64");
    // Cached under the cwd's .sc-data, versioned.
    expect(resolved).toContain(path.join(".sc-data", "agent-binaries", `sc-agent-mac-x64-${AGENT_VERSION}`));
    expect(Buffer.from(await Bun.file(resolved).arrayBuffer()).equals(bytes)).toBe(true);

    // A second call is served from the cache: it resolves even after the source stops
    // serving it.
    served.clear();
    expect(await resolveAgentBinary("mac-x64")).toBe(resolved);
});

test("rejects a checksum mismatch (fails closed, nothing cached)", async () => {
    // Serve a binary but a SHA256SUMS that won't match (different bytes under the name).
    const real = crypto.randomBytes(1024);
    served.set("sc-agent-mac-x64", real);
    // Override the route's view by serving wrong sums: easiest is to corrupt after the
    // store reads — instead serve a second asset's hash. Simpler: tamper the served
    // bytes between the two parallel fetches isn't deterministic, so assert via a
    // dedicated wrong-sum source.
    const wrong = Bun.serve({
        port: 0,
        fetch(req) {
            const url = new URL(req.url);
            if (url.pathname.endsWith("/SHA256SUMS")) {
                return new Response(`${"0".repeat(64)}  sc-agent-mac-x64\n`);
            }
            if (url.pathname.endsWith("/sc-agent-mac-x64")) {
                return new Response(real as unknown as BodyInit);
            }
            return new Response("not found", { status: 404 });
        },
    });
    try {
        await fs.writeFile(".sc-data/config.json", JSON.stringify({ releaseSource: { baseUrl: `http://127.0.0.1:${wrong.port}/dl` } }));
        await expect(resolveAgentBinary("mac-x64")).rejects.toBeInstanceOf(BinaryStoreError);
        expect(await Bun.file(path.join(".sc-data", "agent-binaries", `sc-agent-mac-x64-${AGENT_VERSION}`)).exists()).toBe(false);
    } finally {
        wrong.stop(true);
    }
});

test("prefers a dist/ build over the release source", async () => {
    const distBytes = crypto.randomBytes(2048);
    const distFile = path.join(DIST_DIR, "sc-agent-mac-x64");
    await fs.writeFile(distFile, distBytes);
    // Release source would serve different bytes; dist/ must win and no network used.
    served.set("sc-agent-mac-x64", crypto.randomBytes(2048));
    try {
        const resolved = await resolveAgentBinary("mac-x64");
        expect(resolved).toBe(distFile);
        expect(Buffer.from(await Bun.file(resolved).arrayBuffer()).equals(distBytes)).toBe(true);
    } finally {
        await fs.rm(distFile, { force: true });
    }
});

test("rejects an unsupported platform with a 400", async () => {
    await expect(resolveAgentBinary("solaris-sparc")).rejects.toMatchObject({ status: 400 });
});

test("getLatestVersion reads tag_name from the configured latest endpoint", async () => {
    await fs.writeFile(".sc-data/config.json", JSON.stringify({ releaseSource: { baseUrl, latestUrl: `http://127.0.0.1:${release.port}/latest` } }));
    expect(await getLatestVersion()).toBe("9.9.9");
});
