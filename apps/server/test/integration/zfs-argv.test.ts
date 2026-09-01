import { expect, test } from "bun:test";
import type { ControlMessage } from "@central/shared";
import { AGENT_CAPABILITIES } from "@central/shared";
import { HostAgent } from "../../src/host-agent";
import {
    setDatasetProperty,
    zfsDatasetCreate,
    zfsDatasetDestroy,
    zfsDeviceReplace,
    zfsPoolCreate,
    zfsScrub,
    zfsSnapshotClone,
    zfsSnapshotCreate,
    zfsSnapshotRollback,
    zfsVdevAdd,
} from "../../src/features/zfs/zfs";

// The pool/dataset mutations, checked by the argv they build rather than by
// running them — `zpool create` and `zfs destroy` aren't things a test suite
// gets to try for real. The read paths are exercised against a live host
// instead, where a wrong argv shows up as unparsable output.

/** A host agent that answers every command with success, recording what it was asked to run. */
function makeAgent() {
    const sent: ControlMessage[] = [];
    let agent: HostAgent;
    agent = new HostAgent(
        (msg) => {
            sent.push(msg);
            const requestId = (msg as { requestId?: string }).requestId;
            if (requestId) {
                agent.receive({ type: "execResponse", requestId, result: { stdout: "", stderr: "", code: 0 } });
            }
        },
        "machine-zfs", "host", null, () => {}, "live", null, AGENT_CAPABILITIES,
    );
    return { agent, sent };
}

/** The argv of the one command that was run. */
function argvOf(sent: ControlMessage[]): string[] {
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "execArgvRequest" });
    return (sent[0] as { argv: string[] }).argv;
}

test("a name with a space is one argument, not two — the case that needed quoting", async () => {
    const { agent, sent } = makeAgent();
    await zfsScrub(agent, "sata ssds", "start");
    expect(argvOf(sent)).toEqual(["zpool", "scrub", "sata ssds"]);
});

test("boolean flags land as their own elements", async () => {
    const { agent, sent } = makeAgent();
    await zfsSnapshotCreate(agent, "tank/data", "nightly", true);
    expect(argvOf(sent)).toEqual(["zfs", "snapshot", "-r", "tank/data@nightly"]);

    const off = makeAgent();
    await zfsSnapshotCreate(off.agent, "tank/data", "nightly", false);
    expect(argvOf(off.sent)).toEqual(["zfs", "snapshot", "tank/data@nightly"]);

    const stop = makeAgent();
    await zfsScrub(stop.agent, "tank", "stop");
    expect(argvOf(stop.sent)).toEqual(["zpool", "scrub", "-s", "tank"]);
});

test("a zvol's size and properties become flag/value pairs", async () => {
    const { agent, sent } = makeAgent();
    await zfsDatasetCreate(agent, "tank", "vol", "volume", 1048576, { compression: "lz4", quota: "10G" });
    expect(argvOf(sent)).toEqual([
        "zfs", "create", "-V", "1048576", "-o", "compression=lz4", "-o", "quota=10G", "tank/vol",
    ]);
});

test("a property assignment is a single key=value argument", async () => {
    const { agent, sent } = makeAgent();
    await setDatasetProperty(agent, "tank/data", "compression", "lz4");
    expect(argvOf(sent)).toEqual(["zfs", "set", "compression=lz4", "tank/data"]);
});

test("vdev types are keywords, and a stripe contributes only its devices", async () => {
    const { agent, sent } = makeAgent();
    await zfsPoolCreate(agent, "tank", [
        { type: "mirror", devices: ["/dev/disk/by-id/a", "/dev/disk/by-id/b"] },
        { type: "cache", devices: ["/dev/disk/by-id/c"] },
    ], true);
    expect(argvOf(sent)).toEqual([
        "zpool", "create", "-f", "tank",
        "mirror", "/dev/disk/by-id/a", "/dev/disk/by-id/b",
        "cache", "/dev/disk/by-id/c",
    ]);

    const stripe = makeAgent();
    await zfsPoolCreate(stripe.agent, "tank", [{ type: "stripe", devices: ["/dev/disk/by-id/a"] }]);
    expect(argvOf(stripe.sent)).toEqual(["zpool", "create", "tank", "/dev/disk/by-id/a"]);

    const add = makeAgent();
    await zfsVdevAdd(add.agent, "tank", { type: "raidz2", devices: ["/dev/disk/by-id/a", "/dev/disk/by-id/b"] });
    expect(argvOf(add.sent)).toEqual(["zpool", "add", "tank", "raidz2", "/dev/disk/by-id/a", "/dev/disk/by-id/b"]);
});

test("multi-value commands keep their operand order", async () => {
    const { agent, sent } = makeAgent();
    await zfsSnapshotClone(agent, "tank/data@nightly", "tank/restored");
    expect(argvOf(sent)).toEqual(["zfs", "clone", "tank/data@nightly", "tank/restored"]);

    const replace = makeAgent();
    await zfsDeviceReplace(replace.agent, "tank", "ata-OLD", "/dev/disk/by-id/ata-NEW");
    expect(argvOf(replace.sent)).toEqual(["zpool", "replace", "tank", "ata-OLD", "/dev/disk/by-id/ata-NEW"]);
});

test("a name that would be read as an option is refused before it is run", async () => {
    const { agent, sent } = makeAgent();
    // argv makes this inert as *shell*, but `zfs destroy -r` is still zfs's own
    // option parsing — which is what the leading-character rule guards.
    await expect(zfsDatasetDestroy(agent, "-r", false)).rejects.toThrow(/Invalid ZFS dataset/);
    await expect(zfsScrub(agent, "-s tank", "start")).rejects.toThrow(/Invalid ZFS pool name/);
    expect(sent).toEqual([]);
});

test("the old injection shapes are still refused, and never reach a command", async () => {
    const { agent, sent } = makeAgent();
    await expect(zfsDatasetDestroy(agent, "tank; rm -rf /", false)).rejects.toThrow(/Invalid ZFS dataset/);
    await expect(setDatasetProperty(agent, "tank", "compression", "lz4; id")).rejects.toThrow(/Invalid ZFS property value/);
    await expect(zfsPoolCreate(agent, "tank", [{ type: "mirror; id" as never, devices: ["/dev/disk/by-id/a"] }]))
        .rejects.toThrow(/Invalid vdev type/);
    await expect(zfsSnapshotRollback(agent, "tank/data@$(id)", false)).rejects.toThrow(/Invalid ZFS snapshot name/);
    expect(sent).toEqual([]);
});
