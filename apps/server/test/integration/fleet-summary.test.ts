import { expect, test } from "bun:test";
import type { ServerEntry } from "@central/shared";
import type { Fleet } from "../../src/fleet";
import type { HostAgent } from "../../src/host-agent";
import { FleetSummaryCollector, mergeStacks, summarizePool } from "../../src/features/dashboard/fleet-summary";

// The fleet overview's digest is one fan-out over every online host. These pin
// the parts that would fail quietly: a host missing a subsystem stays null (not
// an error), a subsystem that fails lands in `errors` without taking the host's
// other answers with it, and concurrent callers share one collection.

/** An agent answering by command name, so one fake can play docker, systemd
 *  and zpool at once. `calls` counts the round trips the host actually saw. */
function fakeAgent(answers: Record<string, string | Error>, calls: string[] = []): HostAgent {
    return {
        run: async (argv: string[]) => {
            calls.push(argv.join(" "));
            const key = Object.keys(answers).find((k) => argv.join(" ").startsWith(k));
            const answer = key ? answers[key] : new Error(`unexpected: ${argv.join(" ")}`);
            if (answer instanceof Error) {
                throw answer;
            }
            return { stdout: answer, stderr: "", code: 0 };
        },
    } as unknown as HostAgent;
}

function fakeFleet(hosts: Array<{ entry: ServerEntry; agent: HostAgent }>): Fleet {
    return {
        entries: () => hosts.map((h) => h.entry),
        get: (id: string) => hosts.find((h) => h.entry.id === id)!.agent,
    } as unknown as Fleet;
}

function online(id: string, caps: Partial<Record<"docker" | "systemd" | "zfs", boolean>> = {}): ServerEntry {
    const hostCapabilities = Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, { available: v }]));
    return { id, name: id, status: { serverId: id, state: "online", hostCapabilities } };
}

const PS = [
    JSON.stringify({ ID: "1", Names: "web", State: "running", Labels: "com.docker.compose.project=shop" }),
    JSON.stringify({ ID: "2", Names: "db", State: "exited", Labels: "com.docker.compose.project=shop" }),
    JSON.stringify({ ID: "3", Names: "lone", State: "running", Labels: "" }),
].join("\n");

test("collects docker, failed units and pools for an online host in one pass", async () => {
    const calls: string[] = [];
    const agent = fakeAgent({
        "docker version": "27.0",
        "docker ps": PS,
        "systemctl list-units": "fail2ban.service loaded failed failed Ban hosts\nbackup.timer loaded failed failed Nightly\n",
        "zpool version": "zfs-2.2",
        "zpool list": "tank\t1000\t780\t220\t5\t78\tONLINE\n",
        "zpool status": "  pool: tank\n state: ONLINE\n  scan: scrub repaired 0B in 01:00:00 with 0 errors on Sun Sep  7 03:00:00 2026\nconfig:\n\tNAME  STATE  READ WRITE CKSUM\n\ttank  ONLINE  0 0 0\nerrors: No known data errors\n",
    }, calls);
    const collector = new FleetSummaryCollector(fakeFleet([{ entry: online("a"), agent }]), {
        registeredStacks: () => [{ id: "s1", name: "Shop", hostId: "a", dir: "/opt/shop", composeFile: "compose.yaml", project: "shop", createdAt: 0 }],
    });

    const summary = await collector.get();
    expect(summary.hosts).toHaveLength(1);
    const host = summary.hosts[0];
    expect(host.docker).toEqual({
        containersRunning: 2,
        containersTotal: 3,
        containersCompleted: 0,
        stacks: [{ project: "shop", name: "Shop", status: "partial", running: 1, total: 2, completed: 0 }],
    });
    expect(host.failedUnits).toEqual(["fail2ban.service", "backup.timer"]);
    expect(host.pools?.[0]).toMatchObject({ name: "tank", state: "ONLINE", capacityPct: 78, scrubInProgress: false });
    expect(host.pools?.[0].lastScrubAt).not.toBeNull();
    expect(host.errors).toEqual({});
    // Not `docker system df`: that's the slow call the fleet page must never make.
    expect(calls.some((c) => c.includes("system df"))).toBe(false);
});

test("a capability the agent reported missing is not asked, and stays null without an error", async () => {
    const calls: string[] = [];
    const agent = fakeAgent({ "docker version": "27.0", "docker ps": "", "systemctl list-units": "" }, calls);
    const collector = new FleetSummaryCollector(fakeFleet([{ entry: online("a", { zfs: false }), agent }]), { registeredStacks: () => [] });

    const [host] = (await collector.get()).hosts;
    expect(host.pools).toBeNull();
    expect(host.errors.zfs).toBeUndefined();
    expect(calls.some((c) => c.startsWith("zpool"))).toBe(false);
});

test("one failing subsystem is reported without losing the others", async () => {
    const agent = fakeAgent({
        "docker version": new Error("socket hung up"),
        "systemctl list-units": "",
        "zpool version": "zfs",
        "zpool list": "",
        "zpool status": "",
    });
    const collector = new FleetSummaryCollector(fakeFleet([{ entry: online("a"), agent }]), { registeredStacks: () => [] });

    const [host] = (await collector.get()).hosts;
    expect(host.docker).toBeNull();
    expect(host.errors.docker).toBe("socket hung up");
    expect(host.failedUnits).toEqual([]);
    expect(host.pools).toEqual([]);
});

test("offline hosts are skipped, and concurrent callers share one collection", async () => {
    const calls: string[] = [];
    const agent = fakeAgent({ "docker version": "27.0", "docker ps": "", "systemctl list-units": "", "zpool version": "zfs", "zpool list": "", "zpool status": "" }, calls);
    const offline: ServerEntry = { id: "b", name: "b", status: { serverId: "b", state: "offline" } };
    const collector = new FleetSummaryCollector(fakeFleet([{ entry: online("a"), agent }, { entry: offline, agent }]), { registeredStacks: () => [] });

    const [first, second] = await Promise.all([collector.get(), collector.get()]);
    expect(first).toBe(second);
    expect(first.hosts.map((h) => h.hostId)).toEqual(["a"]);
    const afterFirst = calls.length;
    // Within the cache window a third call costs the host nothing.
    await collector.get();
    expect(calls.length).toBe(afterFirst);
});

// A one-shot that ran to the end (exit 0, and a restart policy that won't
// bring it back) is finished, not down: the stack stays running and the host
// stays healthy. Only the exit-0 containers cost an inspect — and with none
// exited, the fleet poll stays at `docker version` + `docker ps`.
test("a finished one-shot doesn't degrade its stack", async () => {
    const calls: string[] = [];
    const ps = [
        JSON.stringify({ ID: "aaa111", Names: "app", State: "running", Status: "Up 3 days", Labels: "com.docker.compose.project=shop" }),
        JSON.stringify({ ID: "bbb222", Names: "migrations", State: "exited", Status: "Exited (0) 3 days ago", Labels: "com.docker.compose.project=shop" }),
        JSON.stringify({ ID: "ccc333", Names: "worker", State: "exited", Status: "Exited (0) 2 hours ago", Labels: "com.docker.compose.project=shop" }),
        JSON.stringify({ ID: "ddd444", Names: "cron", State: "exited", Status: "Exited (1) 2 hours ago", Labels: "com.docker.compose.project=other" }),
    ].join("\n");
    const agent = fakeAgent({
        "docker version": "27.0",
        "docker ps": ps,
        // Full ids, as inspect prints them: migrations is a one-shot, worker was
        // stopped by hand under a policy that would otherwise keep it up.
        "docker inspect": "bbb222" + "0".repeat(58) + " on-failure\n" + "ccc333" + "0".repeat(58) + " unless-stopped\n",
        "systemctl list-units": "",
    }, calls);
    const collector = new FleetSummaryCollector(fakeFleet([{ entry: online("a", { docker: true, systemd: true }), agent }]), { registeredStacks: () => [] });

    const host = (await collector.get()).hosts[0];
    expect(host.docker).toEqual({
        containersRunning: 1,
        containersTotal: 4,
        containersCompleted: 1,
        stacks: [
            { project: "other", name: "other", status: "stopped", running: 0, total: 1, completed: 0 },
            { project: "shop", name: "shop", status: "partial", running: 1, total: 2, completed: 1 },
        ],
    });
    // Only the exit-0 containers are asked about; the crashed one isn't a candidate.
    const inspect = calls.find((c) => c.startsWith("docker inspect"))!;
    expect(inspect).toContain("bbb222");
    expect(inspect).toContain("ccc333");
    expect(inspect).not.toContain("ddd444");
});

test("mergeStacks: a registered project nothing runs under is down, and registration names an observed one", () => {
    const merged = mergeStacks(
        [{ project: "immich", containers: 5, running: 5, completed: 0, configFiles: "", states: ["running"] }],
        [
            { id: "1", name: "Immich", hostId: "h", dir: "", composeFile: "", project: "immich", createdAt: 0 },
            { id: "2", name: "Paperless", hostId: "h", dir: "", composeFile: "", project: "paperless", createdAt: 0 },
        ],
    );
    expect(merged).toEqual([
        { project: "immich", name: "Immich", status: "running", running: 5, total: 5, completed: 0 },
        { project: "paperless", name: "Paperless", status: "down", running: 0, total: 0, completed: 0 },
    ]);
});

test("summarizePool: only a completed scrub counts as the last scrub", () => {
    const base = { name: "t", state: "ONLINE" as const, sizeBytes: 0, allocatedBytes: 0, freeBytes: 0, fragmentationPct: 0, capacityPct: 10, errors: "", vdevs: [] };
    expect(summarizePool({ ...base, scan: null })).toMatchObject({ lastScrubAt: null, scrubInProgress: false });
    expect(summarizePool({ ...base, scan: { kind: "scrub", state: "in_progress", startedAt: 5 } })).toMatchObject({ lastScrubAt: null, scrubInProgress: true });
    expect(summarizePool({ ...base, scan: { kind: "resilver", state: "completed", startedAt: 5, finishedAt: 9 } })).toMatchObject({ lastScrubAt: null });
    expect(summarizePool({ ...base, scan: { kind: "scrub", state: "completed", startedAt: 5, finishedAt: 9 } })).toMatchObject({ lastScrubAt: 9 });
});
