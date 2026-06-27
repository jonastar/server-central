import { afterAll, beforeAll, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { downloadBinary } from "../../src/agent/agent-cli";
import { Fleet } from "../../src/fleet";
import { NodeServer } from "../../src/node-server";
import { ensureTls, type TlsBundle } from "../../src/tls";

// Regression for the self-update download stalling: the agent fetched the binary,
// received every byte (a burst on the wire), but the write never finalized and the
// download aborted at the 12s timeout. The cause was client-side — streaming a
// fetch Response straight into Bun.write — so this drives the real downloadBinary
// against a real NodeServer serving a real (multi-MB, multi-chunk) binary and
// asserts it completes well under the timeout with byte-for-byte the served file.

// Mirror NodeServer's DIST_DIR + PLATFORM_BINARY so we can plant the served binary.
const DIST_DIR = path.resolve(import.meta.dir, "../../../../dist");
const PLATFORM_BINARY: Record<string, string> = {
    "linux-x64": "sc-agent-linux-x64",
    "mac-x64": "sc-agent-mac-x64",
    "windows-x64": "sc-agent-windows-x64.exe",
};
const osName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux";
const platform = `${osName}-${process.arch}`;
const binPath = path.join(DIST_DIR, PLATFORM_BINARY[platform]);

// A real binary is tens of MB; 8 MB is enough to span many stream chunks (which is
// what surfaced the stall) while keeping the test fast.
const fakeBinary = crypto.randomBytes(8 * 1024 * 1024);

let tmpDir: string;
let prevCwd: string;
let tls: TlsBundle;
let fleet: Fleet;
let server: NodeServer;
// If a developer has a real build at binPath, set it aside and restore it after.
let backupPath: string | null = null;

beforeAll(async () => {
    prevCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-update-"));
    process.chdir(tmpDir);

    await fs.mkdir(DIST_DIR, { recursive: true });
    if (await Bun.file(binPath).exists()) {
        backupPath = `${binPath}.itest-backup`;
        await fs.rename(binPath, backupPath);
    }
    await fs.writeFile(binPath, fakeBinary);

    tls = await ensureTls(path.join(tmpDir, ".sc-tls"));
    fleet = new Fleet(() => {});
    server = new NodeServer(fleet, tls, "127.0.0.1", null, () => {}, null, 0);
    server.start();
});

afterAll(async () => {
    server.stop();
    process.chdir(prevCwd);
    // Restore the original dist binary (or remove the one we planted).
    if (backupPath) {
        await fs.rename(backupPath, binPath);
    } else {
        await fs.rm(binPath, { force: true });
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
});

test(
    "downloadBinary fetches the full binary and completes promptly (no stall to timeout)",
    async () => {
        const token = await server.mintAgentToken("update-machine");
        const dest = path.join(tmpDir, "sc-agent-downloaded");

        const startedAt = Date.now();
        await downloadBinary({
            control: `wss://127.0.0.1:${server.port}/node`,
            altControl: null,
            certPem: tls.caCertPem,
            token,
            dest,
        });
        const elapsed = Date.now() - startedAt;

        // The bug aborted at the 12s DOWNLOAD_TIMEOUT_MS; a healthy local download
        // is sub-second. Assert comfortably below the timeout to catch a stall.
        expect(elapsed).toBeLessThan(8_000);

        const written = new Uint8Array(await Bun.file(dest).arrayBuffer());
        expect(written.byteLength).toBe(fakeBinary.byteLength);
        expect(Buffer.from(written).equals(fakeBinary)).toBe(true);
    },
    15_000,
);

test("downloadBinary rejects when the token is invalid", async () => {
    const dest = path.join(tmpDir, "sc-agent-rejected");
    await expect(
        downloadBinary({
            control: `wss://127.0.0.1:${server.port}/node`,
            altControl: null,
            certPem: tls.caCertPem,
            token: "not-a-real-token",
            dest,
        }),
    ).rejects.toThrow();
    expect(await Bun.file(dest).exists()).toBe(false);
});
