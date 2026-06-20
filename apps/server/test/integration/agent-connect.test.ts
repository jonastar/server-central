import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MetricsSnapshot, ServerEntry } from "@central/shared";
import { Fleet } from "../../src/fleet";
import { NodeServer } from "../../src/node-server";
import { ensureTls, type TlsBundle } from "../../src/tls";
import { attemptIdentify, poll, spawnTestAgent } from "./helpers";

// In-process integration test: a real NodeServer (TLS + WSS) plus the real agent
// CLI (the server entry run with `--agent`) spawned as a subprocess, exercising
// the full enroll → identify → fleet → metrics path without Docker or a binary.

let tmpDir: string;
let prevCwd: string;
let tls: TlsBundle;
let fleet: Fleet;
let server: NodeServer;
const metricsEvents: Array<{ serverId: string; snapshot: MetricsSnapshot }> = [];

function control(): string {
    return `wss://127.0.0.1:${server.port}/node`;
}

/**
 * A currently-connected real remote agent. Agents are keyed by a stable machine
 * id, so reconnects reuse the same entry — we match on "online", not a fresh id.
 * Excludes the "negative-test" sentinel used by `attemptIdentify`, whose
 * closing socket can otherwise be picked up by a concurrently-starting test.
 */
function onlineRemoteAgent(): ServerEntry | undefined {
    return fleet.entries().find((e) => e.status.state === "online" && e.id !== "negative-test");
}

beforeAll(async () => {
    // Isolate all disk writes (.sc-data, .sc-tls) into a throwaway dir.
    prevCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-itest-"));
    process.chdir(tmpDir);

    tls = await ensureTls(path.join(tmpDir, ".sc-tls"));

    const onMetrics = (serverId: string, snapshot: MetricsSnapshot) => {
        metricsEvents.push({ serverId, snapshot });
    };
    // Construct Fleet without init() so the embedded agent doesn't start;
    // we only want remote agents registered via the NodeServer for this test.
    fleet = new Fleet(onMetrics);
    server = new NodeServer(fleet, tls, "127.0.0.1", null, onMetrics, 0);
    server.start();
});

afterAll(async () => {
    server.stop();
    process.chdir(prevCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
});

test(
    "real agent process connects and appears in the fleet as online",
    async () => {
        const { token } = server.mintToken();
        const agent = spawnTestAgent({ control: control(), token, certPath: tls.certPath });
        try {
            const entry = await poll(() => onlineRemoteAgent(), {
                label: "real agent online in fleet",
                timeoutMs: 15_000,
            }).catch((err) => {
                throw new Error(`${err}\n--- agent output ---\n${agent.output()}`);
            });
            expect(entry.status.state).toBe("online");
        } finally {
            await agent.stop();
        }
    },
    20_000,
);

test(
    "real agent connects via a hostname, not just an IP",
    async () => {
        // Regression: Bun enforces hostname↔SAN verification at the TLS layer and
        // ignores checkServerIdentity, so connecting by hostname (a domain in
        // production) used to fail the handshake against the old CN-only cert.
        // The cert now carries a SAN and the agent sends a fixed servername.
        const { token } = server.mintToken();
        const hostControl = `wss://localhost:${server.port}/node`;
        const agent = spawnTestAgent({ control: hostControl, token, certPath: tls.certPath });
        try {
            const entry = await poll(() => onlineRemoteAgent(), {
                label: "real agent online via hostname",
                timeoutMs: 15_000,
            }).catch((err) => {
                throw new Error(`${err}\n--- agent output ---\n${agent.output()}`);
            });
            expect(entry.status.state).toBe("online");
        } finally {
            await agent.stop();
        }
    },
    20_000,
);

test("rejects an agent presenting an invalid token", async () => {
    const result = await attemptIdentify({ port: server.port, certPem: tls.certPem, token: "not-a-real-token" });
    expect(result.acknowledged).toBe(false);
    expect(result.closeCode).toBe(1008);
});

test("accepts an installed agent using a durable (non-expiring) token", async () => {
    // Installed agents reconnect indefinitely, so they authenticate with a
    // durable token issued at install time rather than an enrollment token.
    const agentToken = await server.mintAgentToken("durable-machine");
    const result = await attemptIdentify({ port: server.port, certPem: tls.certPem, token: agentToken });
    expect(result.acknowledged).toBe(true);
});

test(
    "metrics flow from the real agent to the server after connect",
    async () => {
        const { token } = server.mintToken();
        const agent = spawnTestAgent({ control: control(), token, certPath: tls.certPath });
        try {
            const entry = await poll(() => onlineRemoteAgent(), {
                label: "real agent online in fleet",
                timeoutMs: 15_000,
            });
            // The collector needs two samples to compute deltas, so the first real
            // snapshot lands on the second tick (~5s, METRICS_INTERVAL_MS).
            await poll(() => metricsEvents.some((e) => e.serverId === entry.id), {
                label: "metrics from real agent",
                // Two samples at a 5s interval (~10s) plus headroom under suite load.
                timeoutMs: 20_000,
                intervalMs: 250,
            }).catch((err) => {
                throw new Error(`${err}\n--- agent output ---\n${agent.output()}`);
            });
            expect(metricsEvents.find((e) => e.serverId === entry.id)?.snapshot).toBeDefined();
        } finally {
            await agent.stop();
        }
    },
    35_000,
);
