import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MetricsSnapshot, NodeMessage, ServerEntry } from "@central/shared";
import { Fleet } from "../../src/fleet";
import { NodeServer } from "../../src/node-server";
import { ensureTls, type TlsBundle } from "../../src/tls";
import { poll, spawnTestAgent } from "./helpers";

// Reconnect behaviour of the real agent CLI against a real NodeServer: the
// per-attempt connect deadline, endpoint stickiness across attempts, and the
// heartbeat watchdog that escapes a half-open connection.

let tmpDir: string;
let prevCwd: string;
let tls: TlsBundle;
let fleet: Fleet;
let server: NodeServer;

function control(): string {
    return `wss://127.0.0.1:${server.port}/node`;
}

function onlineRemoteAgent(): ServerEntry | undefined {
    return fleet.entries().find((e) => e.status.state === "online");
}

/**
 * A TCP listener that accepts and then says nothing — the shape of a control
 * plane address that resolves and connects but never completes a TLS handshake.
 * Stands in for a black-holed endpoint without needing an unroutable address
 * (which behaves differently inside a container).
 */
function silentListener(): { port: number; stop: () => void } {
    const listener = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data() { }, open() { }, close() { } },
    });
    return { port: listener.port, stop: () => listener.stop(true) };
}

beforeAll(async () => {
    prevCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-reconnect-"));
    process.chdir(tmpDir);

    tls = await ensureTls(path.join(tmpDir, ".sc-tls"));
    const onMetrics = (_serverId: string, _snapshot: MetricsSnapshot) => { };
    fleet = new Fleet(onMetrics);
    server = new NodeServer(fleet, tls, "127.0.0.1", null, onMetrics, null, 0);
    server.start();
});

afterAll(async () => {
    server.stop();
    process.chdir(prevCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
});

test(
    "a hung primary URL times out, falls through to the alt, and is remembered",
    async () => {
        // Without the connect deadline this never completes: the TLS handshake to
        // the silent listener hangs forever and the alt URL is never tried.
        const silent = silentListener();
        const stateDir = path.join(tmpDir, "sticky-state");
        const { token } = server.mintToken();
        const agent = spawnTestAgent({
            control: `wss://127.0.0.1:${silent.port}/node`,
            altControl: control(),
            token,
            certPath: tls.caCertPath,
            env: { SC_AGENT_DIR: stateDir },
        });
        try {
            await poll(() => onlineRemoteAgent(), {
                label: "agent online via the alt URL after the primary timed out",
                // One full connect timeout (10s) on the primary, then the alt.
                timeoutMs: 25_000,
            }).catch((err) => {
                throw new Error(`${err}\n--- agent output ---\n${agent.output()}`);
            });
            expect(agent.output()).toContain("timed out after");

            // The working URL is persisted so the next process/reconnect tries it
            // first instead of paying the primary's timeout again.
            const state = await poll(
                async () => JSON.parse(await Bun.file(path.join(stateDir, "state.json")).text()) as { lastControl?: string },
                { label: "state.json written", timeoutMs: 5_000 },
            );
            expect(state.lastControl).toBe(control());
        } finally {
            await agent.stop();
            silent.stop();
        }
    },
    45_000,
);

test(
    "the control plane beats at heartbeat-capable agents only",
    async () => {
        const withCap = await firstPing({ capabilities: ["heartbeat"] });
        expect(withCap).toBe(true);

        // An agent from before the heartbeat existed ignores unknown messages and
        // has no watchdog, so it must not be pinged.
        const withoutCap = await firstPing({ capabilities: [] });
        expect(withoutCap).toBe(false);
    },
    15_000,
);

test(
    "an agent whose control plane goes silent drops the connection and reconnects",
    async () => {
        // A fake control plane that acknowledges, beats once, then goes quiet —
        // indistinguishable from a half-open socket, which is the case TCP alone
        // never resolves. The agent must give up on it and reconnect.
        const identifies: string[] = [];
        const fake = Bun.serve<{ acked: boolean }>({
            port: 0,
            tls: { cert: tls.certPem, key: tls.keyPem },
            fetch(req, ctx) {
                if (new URL(req.url).pathname === "/node" && ctx.upgrade(req, { data: { acked: false } })) {
                    return undefined as unknown as Response;
                }
                return new Response("nope", { status: 404 });
            },
            websocket: {
                message(ws, raw) {
                    const msg = JSON.parse(String(raw)) as NodeMessage;
                    if (msg.type !== "identify") {
                        return;
                    }
                    identifies.push(msg.machineId);
                    ws.send(JSON.stringify({ type: "acknowledged", nodeId: msg.machineId, active: true }));
                    // One beat to arm the agent's watchdog, then silence forever.
                    ws.send(JSON.stringify({ type: "ping" }));
                },
            },
        });

        const { token } = server.mintToken();
        const agent = spawnTestAgent({
            control: `wss://127.0.0.1:${fake.port}/node`,
            token,
            certPath: tls.caCertPath,
            env: {
                SC_AGENT_DIR: path.join(tmpDir, "watchdog-state"),
                SC_AGENT_HEARTBEAT_TIMEOUT_MS: "2000",
            },
        });
        try {
            await poll(() => identifies.length >= 2, {
                label: "agent reconnecting after the heartbeat stopped",
                // 2s watchdog + 5s reconnect delay, with headroom under suite load.
                timeoutMs: 25_000,
                intervalMs: 100,
            }).catch((err) => {
                throw new Error(`${err}\n--- agent output ---\n${agent.output()}`);
            });
            expect(agent.output()).toContain("No heartbeat from the control plane");
        } finally {
            await agent.stop();
            fake.stop(true);
        }
    },
    40_000,
);

/**
 * Identify against the real node server with the given capabilities and report
 * whether a `ping` arrives promptly (the control plane beats once on connect).
 */
async function firstPing(opts: { capabilities: string[] }): Promise<boolean> {
    const { token } = server.mintToken();
    const info = {
        hostname: "ping-probe", os: "", kernel: "", arch: "", primaryIp: "",
        cpuModel: "", cpuCores: 0, uptimeSeconds: 0, capturedAt: Date.now(),
    };
    const ws = new WebSocket(`wss://127.0.0.1:${server.port}/node`, {
        // @ts-expect-error Bun-specific TLS option
        tls: { ca: tls.caCertPem },
    });
    try {
        return await new Promise<boolean>((resolve, reject) => {
            const timer = setTimeout(() => resolve(false), 2_000);
            ws.onopen = () => ws.send(JSON.stringify({
                type: "identify", token, info, machineId: `ping-probe-${opts.capabilities.join("-")}`,
                mode: "live", capabilities: opts.capabilities,
            } satisfies NodeMessage));
            ws.onmessage = (event) => {
                if (JSON.parse(String(event.data)).type === "ping") {
                    clearTimeout(timer);
                    resolve(true);
                }
            };
            ws.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket error")); };
        });
    } finally {
        ws.close();
    }
}
