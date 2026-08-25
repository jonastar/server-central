import { afterAll, beforeAll, expect, test } from "bun:test";
import { dockerList } from "../../src/features/docker/docker";
import { startLab, labSupported, type Lab } from "./lab";

// Proves the lab itself: three separate hosts, each with its own real dockerd,
// all enrolled in the control plane and joined into one Swarm. Every assertion
// here is something the fake-agent tests structurally cannot make — that a
// command ran on *that* host, against *that* daemon.

const support = await labSupported();
const itLab = support.ok ? test : test.skip;
if (!support.ok) {
    console.warn(`e2e lab skipped — ${support.reason}`);
}

let lab: Lab;

beforeAll(async () => {
    if (support.ok) {
        lab = await startLab({ nodes: 3 });
    }
}, 300_000);

afterAll(async () => {
    await lab?.stop();
});

itLab("every node enrolls and reports itself online", () => {
    expect(lab.nodes).toHaveLength(3);
    for (const node of lab.nodes) {
        const entry = lab.entry(node);
        expect(entry.status.state).toBe("online");
        expect(entry.status.info?.hostname).toBe(node.name);
    }
});

itLab("the agent runs as a systemd service on a real host", async () => {
    const res = await lab.manager.exec("systemctl is-active sc-agent");
    expect(res.stdout.trim()).toBe("active");
});

itLab("docker probes as available on every node", () => {
    for (const node of lab.nodes) {
        expect(lab.entry(node).status.hostCapabilities?.docker).toMatchObject({ available: true });
    }
});

itLab("the daemons are genuinely separate", async () => {
    const second = lab.nodes[1]!;
    await lab.loadImage("alpine:3.20");
    await second.execOk("docker run -d --name only-here alpine:3.20 sleep 300");

    const seen = await Promise.all(
        lab.nodes.map(async (node) => {
            const state = await dockerList(lab.agent(node));
            expect(state.available).toBe(true);
            return state.containers.some((c) => c.name === "only-here");
        }),
    );

    // Exactly one host has it — a shared daemon would show it on all three.
    expect(seen.filter(Boolean)).toHaveLength(1);
    expect(seen[1]).toBe(true);
}, 120_000);

itLab("the nodes form one swarm with the expected roles", async () => {
    const res = await lab.manager.exec("docker node ls --format '{{.Hostname}} {{.ManagerStatus}}'");
    expect(res.code).toBe(0);

    const roles = new Map(
        res.stdout.trim().split("\n").map((line) => {
            const [hostname, ...rest] = line.trim().split(/\s+/);
            return [hostname!, rest.join(" ")] as const;
        }),
    );

    expect([...roles.keys()].sort()).toEqual(lab.nodes.map((n) => n.name).sort());
    expect(roles.get(lab.manager.name)).toBe("Leader");
    for (const worker of lab.nodes.slice(1)) {
        expect(roles.get(worker.name)).toBe("");
    }
});

itLab("a swarm stack schedules across all three nodes", async () => {
    const compose = [
        "services:",
        "  web:",
        "    image: alpine:3.20",
        "    command: sleep 600",
        "    deploy:",
        "      replicas: 3",
        "      placement:",
        "        max_replicas_per_node: 1",
    ].join("\n");

    await lab.loadImage("alpine:3.20");
    await lab.manager.execOk("mkdir -p /stack");
    await lab.manager.writeFile("/stack/compose.yml", compose);
    await lab.manager.execOk("cd /stack && docker stack deploy -c compose.yml lab");

    let placedOn: string[] = [];
    for (let i = 0; i < 60; i++) {
        const ps = await lab.manager.execOk(
            "docker stack ps lab --filter desired-state=running --format '{{.Node}}'",
        );
        placedOn = ps.trim().split("\n").filter(Boolean);
        if (placedOn.length === 3) {
            break;
        }
        await Bun.sleep(1000);
    }

    expect([...new Set(placedOn)].sort()).toEqual(lab.nodes.map((n) => n.name).sort());
}, 300_000);
