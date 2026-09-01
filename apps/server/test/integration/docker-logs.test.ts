import { expect, test } from "bun:test";
import { dockerContainerLogs } from "../../src/features/docker/docker";
import type { HostAgent } from "../../src/host-agent";

// `docker logs` demultiplexes a container's stdout and stderr onto its own two
// fds. Run through a shell with `2>&1` they arrived as one ordered stream; run
// as an argv they arrive as two, and the order is rebuilt from the timestamps
// docker stamps each line with. Verified against a real container's mixed log
// too — these pin the shapes that are awkward to find in the wild.

function fakeAgent(stdout: string, stderr = "", code = 0): { host: HostAgent; argv: string[][] } {
    const argv: string[][] = [];
    const host = {
        run: async (a: string[]) => {
            argv.push(a);
            return { stdout, stderr, code };
        },
    } as unknown as HostAgent;
    return { host, argv };
}

const OUT = [
    "2026-08-31T10:00:00.000000001Z access one",
    "2026-08-31T10:00:00.000000003Z access two",
    "",
].join("\n");
const ERR = [
    "2026-08-31T10:00:00.000000002Z error one",
    "2026-08-31T10:00:00.000000004Z error two",
    "",
].join("\n");

test("the two streams are interleaved by timestamp, with the prefixes stripped", async () => {
    const { host } = fakeAgent(OUT, ERR);
    const logs = await dockerContainerLogs(host, "web", { limit: 10, order: "oldest", since: "" });
    expect(logs.split("\n")).toEqual(["access one", "error one", "access two", "error two"]);
});

test("timestamps are asked for even when they aren't wanted, and kept when they are", async () => {
    const off = fakeAgent(OUT, ERR);
    await dockerContainerLogs(off.host, "web", { limit: 10, order: "oldest", since: "" });
    expect(off.argv[0]).toContain("--timestamps");

    const on = fakeAgent(OUT, ERR);
    const logs = await dockerContainerLogs(on.host, "web", { limit: 10, order: "oldest", since: "", timestamps: true });
    expect(logs.split("\n")[0]).toBe("2026-08-31T10:00:00.000000001Z access one");
});

test("newest-first reverses the merged order, not each stream separately", async () => {
    const { host } = fakeAgent(OUT, ERR);
    const logs = await dockerContainerLogs(host, "web", { limit: 10, order: "newest", since: "" });
    expect(logs.split("\n")).toEqual(["error two", "access two", "error one", "access one"]);
});

test("an unstamped continuation line stays with the entry above it", async () => {
    // A stack trace's later lines: docker stamps the first, and a line it didn't
    // stamp must not sort to the top (empty timestamp) and split the entry.
    const stdout = [
        "2026-08-31T10:00:00.000000005Z Traceback:",
        "    at frame one",
        "    at frame two",
        "",
    ].join("\n");
    const { host } = fakeAgent(stdout, "2026-08-31T10:00:00.000000001Z earlier\n");
    const logs = await dockerContainerLogs(host, "web", { limit: 10, order: "oldest", since: "" });
    expect(logs.split("\n")).toEqual(["earlier", "Traceback:", "    at frame one", "    at frame two"]);
});

test("a blank line inside the log survives; only the trailing newline is dropped", async () => {
    const stdout = [
        "2026-08-31T10:00:00.000000001Z first",
        "2026-08-31T10:00:00.000000002Z ",
        "2026-08-31T10:00:00.000000003Z third",
        "",
    ].join("\n");
    const { host } = fakeAgent(stdout);
    const logs = await dockerContainerLogs(host, "web", { limit: 10, order: "oldest", since: "" });
    expect(logs.split("\n")).toEqual(["first", "", "third"]);
});

test("a failed command shows its error instead of an empty pane", async () => {
    const { host } = fakeAgent("", "Error response from daemon: No such container: ghost", 1);
    const logs = await dockerContainerLogs(host, "ghost", { limit: 10, order: "oldest", since: "" });
    expect(logs).toMatch(/No such container/);
});
