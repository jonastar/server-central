import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMode, MetricsSnapshot } from "@central/shared";
import { Fleet } from "../../src/fleet";
import { NodeProxy } from "../../src/node-proxy";

// Unit-level coverage for the machine-id keying + live/installed priority rules
// in Fleet. No sockets — we drive NodeProxy instances directly.

const MACHINE = "machine-abc";

let tmpDir: string;
let prevCwd: string;
const metricsEvents: string[] = [];

function onMetrics(serverId: string) {
    metricsEvents.push(serverId);
}

function makeProxy(mode: AgentMode): NodeProxy {
    return new NodeProxy(() => {}, MACHINE, `host-${mode}`, null, onMetrics, mode);
}

function fakeSnapshot(): MetricsSnapshot {
    return {
        ts: Date.now(),
        cpu: { total: 0, perCore: [] },
        memory: { totalKb: 0, usedKb: 0, availableKb: 0, swapTotalKb: 0, swapUsedKb: 0 },
        network: { rxBytesPerSec: 0, txBytesPerSec: 0 },
        diskIo: { readBytesPerSec: 0, writeBytesPerSec: 0 },
        disks: [],
    };
}

beforeAll(async () => {
    // Fleet persists to .sc-data in cwd; isolate it.
    prevCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-fleet-"));
    process.chdir(tmpDir);
});

afterAll(async () => {
    process.chdir(prevCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
});

test("installed agent takes priority over a live agent on the same machine", () => {
    const fleet = new Fleet(onMetrics);

    const live = makeProxy("live");
    expect(fleet.register(live)).toBe(true);
    expect(fleet.get(MACHINE)).toBe(live);
    expect(fleet.entries().find((e) => e.id === MACHINE)?.status.mode).toBe("live");

    // An installed agent for the same machine takes over.
    const installed = makeProxy("installed");
    expect(fleet.register(installed)).toBe(true);
    expect(fleet.get(MACHINE)).toBe(installed);
    expect(fleet.entries().find((e) => e.id === MACHINE)?.status.mode).toBe("installed");

    // The demoted live agent is now a dummy: its metrics are suppressed.
    metricsEvents.length = 0;
    live.receive({ type: "metrics", snapshot: fakeSnapshot() });
    installed.receive({ type: "metrics", snapshot: fakeSnapshot() });
    expect(metricsEvents).toEqual([MACHINE]);
});

test("a live agent arriving after an installed one is a standby and never evicts it", () => {
    const fleet = new Fleet(onMetrics);

    const installed = makeProxy("installed");
    expect(fleet.register(installed)).toBe(true);

    const live = makeProxy("live");
    expect(fleet.register(live)).toBe(false); // standby/dummy
    expect(fleet.get(MACHINE)).toBe(installed);

    // The standby disconnecting must not take the machine offline.
    fleet.deregister(live);
    expect(fleet.entries().find((e) => e.id === MACHINE)?.status.state).toBe("online");
    expect(fleet.get(MACHINE)).toBe(installed);

    // The active agent disconnecting does mark it offline.
    fleet.deregister(installed);
    expect(fleet.entries().find((e) => e.id === MACHINE)?.status.state).toBe("offline");
});

test("a standby is visible in entries and is promoted when the active disconnects", () => {
    const fleet = new Fleet(onMetrics);

    const installed = makeProxy("installed");
    fleet.register(installed);
    const live = makeProxy("live");
    expect(fleet.register(live)).toBe(false); // standby

    // The standby is listed under the active machine's entry.
    const entry = fleet.entries().find((e) => e.id === MACHINE)!;
    expect(entry.status.mode).toBe("installed");
    expect(entry.status.standbys?.map((s) => s.mode)).toEqual(["live"]);

    // When the active disconnects, the standby is promoted (not taken offline).
    fleet.deregister(installed);
    const promoted = fleet.entries().find((e) => e.id === MACHINE);
    expect(promoted?.status.state).toBe("online");
    expect(promoted?.status.mode).toBe("live");
    expect(promoted?.status.standbys).toBeUndefined();
    expect(fleet.get(MACHINE)).toBe(live);

    // The promoted agent resumes forwarding metrics (it was reactivated).
    metricsEvents.length = 0;
    live.receive({ type: "metrics", snapshot: fakeSnapshot() });
    expect(metricsEvents).toEqual([MACHINE]);
});

test("same-mode reconnect replaces the prior connection", () => {
    const fleet = new Fleet(onMetrics);

    const first = makeProxy("installed");
    expect(fleet.register(first)).toBe(true);

    const second = makeProxy("installed");
    expect(fleet.register(second)).toBe(true);
    expect(fleet.get(MACHINE)).toBe(second);

    // The stale first connection closing must not evict the new one.
    fleet.deregister(first);
    expect(fleet.get(MACHINE)).toBe(second);
    expect(fleet.entries().find((e) => e.id === MACHINE)?.status.state).toBe("online");
});
