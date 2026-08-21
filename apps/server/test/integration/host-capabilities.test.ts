import { expect, test } from "bun:test";
import type { ControlMessage, HostCapabilityReport } from "@central/shared";
import { AGENT_CAPABILITIES, HOST_CAPABILITIES } from "@central/shared";
import { probeHostCapabilities } from "../../src/agent/host-capabilities";
import { agentFeatures } from "../../src/agent/features";
import { assertHostProbeCoverage, composeHostProbes, defineAgentFeatures } from "../../src/feature";
import { HostAgent } from "../../src/host-agent";

// Host capability probing: the agent-side probes' contract, and the control
// plane's three-state handling of the report (available / unavailable /
// unknown). The probes themselves are machine-dependent — this box may or may
// not have ZFS — so the assertions here are the invariants that hold anywhere.

const MACHINE = "machine-caps";

function makeAgent(opts: { capabilities?: readonly string[]; report?: HostCapabilityReport } = {}) {
    const sent: ControlMessage[] = [];
    const agent = new HostAgent(
        (msg) => sent.push(msg),
        MACHINE,
        "host",
        null,
        () => {},
        "live",
        null,
        opts.capabilities ?? AGENT_CAPABILITIES,
        opts.report ?? {},
    );
    return { agent, sent };
}

test("every declared host capability has exactly one feature probing it", () => {
    // The compile-time half is that `requiresHostCapability` is typed to the
    // union; this is the other half — the node registry answers all of it.
    expect(() => assertHostProbeCoverage(agentFeatures)).not.toThrow();
});

test("two features claiming one capability is rejected", () => {
    const dupe = defineAgentFeatures(
        { id: "a", hostProbe: { capability: "zfs", probe: async () => ({ available: true }) } },
        { id: "b", hostProbe: { capability: "zfs", probe: async () => ({ available: true }) } },
    );
    expect(() => assertHostProbeCoverage(dupe)).toThrow(/both probe host capability "zfs"/);
});

test("a throwing probe degrades to unavailable instead of failing the report", async () => {
    // The report rides on identify, so an unhandled throw here would fail the
    // agent's whole connect rather than one capability.
    const report = await composeHostProbes(defineAgentFeatures(
        { id: "boom", hostProbe: { capability: "zfs", probe: async () => { throw new Error("nope"); } } },
        { id: "systemd", hostProbe: { capability: "systemd", probe: async () => ({ available: true }) } },
    ));
    expect(report.zfs).toEqual({ available: false, detail: 'Probe for "boom" failed: nope' });
    expect(report.systemd?.available).toBe(true);
});

test("probes answer every declared capability", async () => {
    const report = await probeHostCapabilities();
    expect(Object.keys(report).sort()).toEqual([...HOST_CAPABILITIES].sort());
});

test("an unavailable probe always explains itself", async () => {
    // The greyed-out sidebar item can't say why; `detail` is the only surface
    // that can, so a bare `available: false` would be a dead end for the user.
    const report = await probeHostCapabilities();
    for (const [id, result] of Object.entries(report)) {
        expect(typeof result.available).toBe("boolean");
        if (!result.available) {
            expect(result.detail, `${id} is unavailable with no detail`).toBeTruthy();
        }
    }
});

test("probes survive a PATH with nothing on it", async () => {
    // Probes run on the connect path; one that throws would take the whole
    // report (and the agent's identify) down with it.
    const prev = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
        const report = await probeHostCapabilities();
        expect(report.zfs?.available).toBe(false);
        expect(report.zfs?.detail).toContain("zfsutils-linux");
        expect(report.docker?.available).toBe(false);
    } finally {
        process.env.PATH = prev;
    }
});

test("no report means unknown, not empty", () => {
    // An agent too old to probe must not look like a host with nothing on it —
    // status() omits the field entirely so the UI's `=== false` checks miss.
    const { agent } = makeAgent();
    const status = agent.status();
    expect(status.hostCapabilities).toBeUndefined();
    expect(status.hostCapabilitiesAt).toBeUndefined();
    expect(agent.hostCapabilityReport()).toEqual({});
});

test("a report from identify surfaces on status", () => {
    const { agent } = makeAgent({
        report: { zfs: { available: false, detail: "no module" }, systemd: { available: true } },
    });
    const status = agent.status();
    expect(status.hostCapabilities?.zfs).toEqual({ available: false, detail: "no module" });
    expect(status.hostCapabilities?.systemd?.available).toBe(true);
    expect(status.hostCapabilitiesAt).toBeGreaterThan(0);
});

test("re-detect is refused on an agent that can't answer it", async () => {
    // Older agents ignore unknown message kinds, so sending anyway would hang
    // until the 30s request timeout instead of failing with something readable.
    const { agent, sent } = makeAgent({ capabilities: ["httpRequest"] });
    await expect(agent.redetectHostCapabilities()).rejects.toThrow(/predates host capability probing/);
    expect(sent).toHaveLength(0);
});

test("re-detect replaces the cached report", async () => {
    const { agent, sent } = makeAgent({ report: { zfs: { available: false, detail: "no module" } } });

    const pending = agent.redetectHostCapabilities();
    const request = sent.at(-1);
    expect(request?.type).toBe("hostCapabilitiesRequest");

    agent.receive({
        type: "hostCapabilitiesResponse",
        requestId: (request as { requestId: string }).requestId,
        report: { zfs: { available: true } },
    });

    expect(await pending).toEqual({ zfs: { available: true } });
    expect(agent.status().hostCapabilities?.zfs?.available).toBe(true);
});
