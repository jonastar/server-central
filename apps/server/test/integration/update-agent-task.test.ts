import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ControlMessage, SystemInfo } from "@central/shared";
import { AGENT_VERSION } from "@central/shared";
import { AppStore } from "../../src/apps";
import { Fleet } from "../../src/fleet";
import { HostAgent } from "../../src/host-agent";
import { taskHandlers, type TaskCtx } from "../../src/tasks/types";

// Unit-level coverage (no sockets, real Fleet/HostAgent — same style as
// fleet-priority.test.ts) for the `update_agent` task handler's reconnect wait:
// it must not resolve merely because the agent acknowledged the update — only
// once the fleet sees an actual new connection for that machine online on the
// target version, mirroring the real disconnect-to-swap-binary-then-reconnect
// cycle a self-update goes through.

const MACHINE = "update-machine";

let tmpDir: string;
let prevCwd: string;

beforeAll(async () => {
    // Fleet persists to .sc-data in cwd; isolate it.
    prevCwd = process.cwd();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-update-agent-task-"));
    process.chdir(tmpDir);
});

afterAll(async () => {
    process.chdir(prevCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
});

function fakeInfo(version: string): SystemInfo {
    return {
        hostname: "h", os: "linux", kernel: "", arch: "x64", primaryIp: "",
        cpuModel: "", cpuCores: 1, uptimeSeconds: 0, capturedAt: Date.now(),
        agentVersion: version,
    };
}

/** An installed HostAgent whose `updateService` auto-acknowledges, like a real
 *  agent would, without actually disconnecting — the test drives the
 *  disconnect/reconnect itself via `fleet.deregister`/a fresh instance. */
function makeInstalledAgent(fleet: Fleet, version: string): HostAgent {
    let agent: HostAgent;
    const sendControl = (msg: ControlMessage) => {
        if (msg.type === "updateService") {
            queueMicrotask(() => agent.receive({ type: "updateServiceResponse", requestId: msg.requestId }));
        }
    };
    agent = new HostAgent(sendControl, MACHINE, "host", fakeInfo(version), () => {}, "installed");
    fleet.register(agent);
    return agent;
}

function fakeCtx(fleet: Fleet, agent: HostAgent): TaskCtx {
    return { signal: new AbortController().signal, agent, target: MACHINE, fleet, apps: new AppStore(fleet), log: () => {} };
}

test("update_agent does not resolve on ack alone — it waits for a genuine reconnect", async () => {
    const fleet = new Fleet(() => {});
    const oldAgent = makeInstalledAgent(fleet, "0.0.0-old");

    const run = taskHandlers.update_agent({ kind: "update_agent" }, fakeCtx(fleet, oldAgent));

    let settled = false;
    void run.then(() => { settled = true; });

    // Long enough for the ack + first poll tick (RECONNECT_POLL_MS is 2s) to have
    // definitely happened, well short of it resolving from the ack alone.
    await Bun.sleep(300);
    expect(settled).toBe(false);

    // Simulate the real cycle: the old connection drops (as it does mid-restart)...
    fleet.deregister(oldAgent);
    await Bun.sleep(50);
    expect(settled).toBe(false);
    // ...and a new connection for the same machine comes back on the new version.
    makeInstalledAgent(fleet, AGENT_VERSION);

    expect(await run).toEqual({ kind: "update_agent" });
    expect(settled).toBe(true);
});

test("update_agent fails fast if the agent reconnects on the wrong version", async () => {
    const fleet = new Fleet(() => {});
    const oldAgent = makeInstalledAgent(fleet, "0.0.0-old");

    const run = taskHandlers.update_agent({ kind: "update_agent" }, fakeCtx(fleet, oldAgent));

    fleet.deregister(oldAgent);
    await Bun.sleep(50);
    // Reconnects, but not on the version we asked for (e.g. control-plane
    // AGENT_VERSION drifted from what the just-built binary actually reports).
    makeInstalledAgent(fleet, "some-other-version");

    await expect(run).rejects.toThrow(/reconnected on some-other-version, expected/);
});

test("update_agent times out if the agent never reconnects", async () => {
    const fleet = new Fleet(() => {});
    const oldAgent = makeInstalledAgent(fleet, "0.0.0-old");

    // Rather than waiting out the real 5-minute timeout, prove the same shape
    // with an already-aborted signal: the poll loop must exit promptly instead
    // of hanging, and report a clear error rather than a false success.
    const controller = new AbortController();
    controller.abort();
    const ctx: TaskCtx = { signal: controller.signal, agent: oldAgent, target: MACHINE, fleet, apps: new AppStore(fleet), log: () => {} };

    await expect(taskHandlers.update_agent({ kind: "update_agent" }, ctx)).rejects.toThrow();
});
