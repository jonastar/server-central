import { expect, test } from "bun:test";
import type { ControlMessage } from "@central/shared";
import { AGENT_CAPABILITIES } from "@central/shared";
import { HostAgent } from "../../src/host-agent";

// An agent that predates `openShell.asUser` ignores the field and opens a shell
// as its own user — root. Every other unsupported request fails closed (a
// timeout, or a capability check); this one would have failed *open*, handing a
// mapped operator the root terminal their mapping exists to deny. The gate below
// is what makes it fail closed like the rest.

function makeAgent(capabilities: readonly string[]) {
    const sent: ControlMessage[] = [];
    const agent = new HostAgent((msg) => sent.push(msg), "machine-shell", "host", null, () => {}, "live", null, capabilities);
    return { agent, sent };
}

test("an outdated agent refuses an impersonated shell instead of opening a root one", async () => {
    const { agent, sent } = makeAgent([]);
    await expect(agent.openShell(80, 24, "deploy")).rejects.toThrow(/predates per-user shells/);
    expect(sent).toEqual([]);
});

test("the same agent still opens an un-impersonated shell", async () => {
    const { agent, sent } = makeAgent([]);
    await agent.openShell(80, 24, null);
    expect(sent[0]).toMatchObject({ type: "openShell", asUser: null });
});

test("a container terminal is unaffected — its command ignores asUser by design", async () => {
    const { agent, sent } = makeAgent([]);
    await agent.openShell(80, 24, null, "docker exec -it abc sh");
    expect(sent[0]).toMatchObject({ type: "openShell", command: "docker exec -it abc sh" });
});

test("a current agent gets the impersonated shell it advertises support for", async () => {
    const { agent, sent } = makeAgent(AGENT_CAPABILITIES);
    await agent.openShell(80, 24, "deploy");
    expect(sent[0]).toMatchObject({ type: "openShell", asUser: "deploy" });
});
