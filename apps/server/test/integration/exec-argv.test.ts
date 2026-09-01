import { expect, test } from "bun:test";
import type { ControlMessage } from "@central/shared";
import { AGENT_CAPABILITIES } from "@central/shared";
import { HostAgent } from "../../src/host-agent";
import { shellCommandFor } from "../../src/shell-quote";

// `run`/`runStream` exist so a value the control plane interpolates stops being
// syntax the host re-parses. The argument below is the shape that motivated it:
// a log window token reaching `docker logs --since <token>` from an unvalidated
// request body. It must survive as one literal argument on a current agent, and
// stay inert inside the quoting on an agent too old for `execArgv`.
const INJECTION = "1h; id > /tmp/pwn;";

function makeAgent(capabilities: readonly string[]) {
    const sent: ControlMessage[] = [];
    const agent = new HostAgent((msg) => sent.push(msg), "machine-exec", "host", null, () => {}, "live", null, capabilities);
    return { agent, sent };
}

/** Reply to whatever request the agent just sent, as the host would. */
function reply(agent: HostAgent, sent: ControlMessage[], msg: (requestId: string) => Parameters<HostAgent["receive"]>[0]): void {
    const requestId = (sent[sent.length - 1] as { requestId: string }).requestId;
    agent.receive(msg(requestId));
}

test("a current agent gets the argv verbatim, with no command string at all", async () => {
    const { agent, sent } = makeAgent(AGENT_CAPABILITIES);
    const argv = ["docker", "logs", "--since", INJECTION, "abc"];

    const run = agent.run(argv);
    expect(sent[0]).toMatchObject({ type: "execArgvRequest", argv });
    expect(sent[0]).not.toHaveProperty("command");

    reply(agent, sent, (requestId) => ({ type: "execResponse", requestId, result: { stdout: "ok", stderr: "", code: 0 } }));
    expect(await run).toEqual({ stdout: "ok", stderr: "", code: 0 });
});

test("cwd and env ride along as fields rather than as shell syntax", async () => {
    const { agent, sent } = makeAgent(AGENT_CAPABILITIES);

    const run = agent.run(["docker", "compose", "up", "-d"], { cwd: "/srv/it's mine", env: { COMPOSE_PROJECT_NAME: "web" } });
    expect(sent[0]).toMatchObject({
        type: "execArgvRequest",
        cwd: "/srv/it's mine",
        env: { COMPOSE_PROJECT_NAME: "web" },
    });

    reply(agent, sent, (requestId) => ({ type: "execResponse", requestId, result: { stdout: "", stderr: "", code: 0 } }));
    await run;
});

test("an agent too old for execArgv gets a quoted command string that keeps the argument inert", async () => {
    const { agent, sent } = makeAgent([]);

    const run = agent.run(["docker", "logs", "--since", INJECTION, "abc"]);
    expect(sent[0]).toEqual({
        type: "execRequest",
        requestId: expect.any(String),
        command: `'docker' 'logs' '--since' '1h; id > /tmp/pwn;' 'abc'`,
    });

    reply(agent, sent, (requestId) => ({ type: "execResponse", requestId, result: { stdout: "", stderr: "", code: 0 } }));
    await run;
});

test("runStream uses the argv stream when it can, and the quoted stream when it can't", async () => {
    const current = makeAgent(AGENT_CAPABILITIES);
    const currentRun = current.agent.runStream(["docker", "pull", "nginx"], () => {});
    expect(current.sent[0]).toMatchObject({ type: "execArgvStreamRequest", argv: ["docker", "pull", "nginx"] });
    reply(current.agent, current.sent, (requestId) => ({ type: "execStreamEnd", requestId, code: 0 }));
    expect((await currentRun).code).toBe(0);

    // Streaming but not argv — the middle generation, which still needs the
    // string form and so still depends on the quoting being right.
    const older = makeAgent(["execStream"]);
    const olderRun = older.agent.runStream(["docker", "pull", INJECTION], () => {});
    expect(older.sent[0]).toMatchObject({
        type: "execStreamRequest",
        command: `'docker' 'pull' '1h; id > /tmp/pwn;'`,
    });
    reply(older.agent, older.sent, (requestId) => ({ type: "execStreamEnd", requestId, code: 0 }));
    await olderRun;
});

test("streamed chunks reach the caller and accumulate into the result", async () => {
    const { agent, sent } = makeAgent(AGENT_CAPABILITIES);
    const chunks: string[] = [];

    const run = agent.runStream(["docker", "pull", "nginx"], (stream, data) => chunks.push(`${stream}:${data}`));
    const requestId = (sent[0] as { requestId: string }).requestId;
    agent.receive({ type: "execChunk", requestId, stream: "stdout", data: "pulling\n" });
    agent.receive({ type: "execChunk", requestId, stream: "stderr", data: "warn\n" });
    agent.receive({ type: "execStreamEnd", requestId, code: 0 });

    expect(chunks).toEqual(["stdout:pulling\n", "stderr:warn\n"]);
    expect(await run).toEqual({ stdout: "pulling\n", stderr: "warn\n", code: 0 });
});

test("an empty argv is refused rather than sent", async () => {
    const { agent, sent } = makeAgent(AGENT_CAPABILITIES);
    await expect(agent.run([])).rejects.toThrow(/empty argv/);
    await expect(agent.runStream([], () => {})).rejects.toThrow(/empty argv/);
    expect(sent).toEqual([]);
});

test("shellCommandFor renders cwd, env and embedded quotes the shell will read back", () => {
    expect(shellCommandFor(["zfs", "destroy", "tank/it's mine"]))
        .toBe(`'zfs' 'destroy' 'tank/it'\\''s mine'`);
    expect(shellCommandFor(["ls"], { cwd: "/srv/stacks" }))
        .toBe(`cd '/srv/stacks' && 'ls'`);
    expect(shellCommandFor(["ls"], { cwd: "/srv", env: { TERM: "dumb" } }))
        .toBe(`cd '/srv' && TERM='dumb' 'ls'`);
    expect(() => shellCommandFor(["ls"], { env: { "BAD;NAME": "x" } })).toThrow(/environment variable name/);
    expect(() => shellCommandFor([])).toThrow(/empty argv/);
});

// ---- detach, and the glob RPC ----------------------------------------------------

test("a detached run carries the log path, and returns before the command finishes", async () => {
    const { agent, sent } = makeAgent(AGENT_CAPABILITIES);
    const run = agent.run(["sh", "-c", "docker pull nginx"], { detach: { logPath: "/tmp/deploy.log" } });
    expect(sent[0]).toMatchObject({ type: "execArgvRequest", detach: { logPath: "/tmp/deploy.log" } });
    reply(agent, sent, (requestId) => ({ type: "execResponse", requestId, result: { stdout: "", stderr: "", code: 0 } }));
    expect((await run).code).toBe(0);
});

test("an agent too old for execArgv gets the shell's own way of detaching", async () => {
    const { agent, sent } = makeAgent([]);
    const run = agent.run(["docker", "pull", "nginx"], { detach: { logPath: "/tmp/deploy.log" } });
    expect(sent[0]).toMatchObject({
        type: "execRequest",
        command: `nohup 'docker' 'pull' 'nginx' >'/tmp/deploy.log' 2>&1 &`,
    });
    reply(agent, sent, (requestId) => ({ type: "execResponse", requestId, result: { stdout: "", stderr: "", code: 0 } }));
    await run;
});

test("resolvePaths asks the agent when it can, and runs the shell loop when it can't", async () => {
    const current = makeAgent(AGENT_CAPABILITIES);
    const rpc = current.agent.resolvePaths(["/dev/ttyACM*"]);
    expect(current.sent[0]).toMatchObject({ type: "resolvePathsRequest", patterns: ["/dev/ttyACM*"] });
    reply(current.agent, current.sent, (requestId) => ({
        type: "resolvePathsResponse", requestId, result: [{ path: "/dev/ttyACM0", realPath: "/dev/ttyACM0" }],
    }));
    expect(await rpc).toEqual([{ path: "/dev/ttyACM0", realPath: "/dev/ttyACM0" }]);

    const older = makeAgent([]);
    const loop = older.agent.resolvePaths(["/dev/serial/by-id/*"]);
    expect((older.sent[0] as { command: string }).command).toContain("for p in /dev/serial/by-id/*;");
    reply(older.agent, older.sent, (requestId) => ({
        type: "execResponse",
        requestId,
        result: { stdout: "/dev/serial/by-id/usb-FTDI\t/dev/ttyUSB0\n", stderr: "", code: 0 },
    }));
    expect(await loop).toEqual([{ path: "/dev/serial/by-id/usb-FTDI", realPath: "/dev/ttyUSB0" }]);
});

test("a glob pattern is shape-checked — it is the one value a shell still sees unquoted", async () => {
    const { agent, sent } = makeAgent([]);
    // Quoting it would stop the glob expanding, so the pattern has to be safe as
    // written; anything that isn't never reaches the command.
    await expect(agent.resolvePaths(["/dev/*; cat /etc/passwd"])).rejects.toThrow(/Invalid path pattern/);
    await expect(agent.resolvePaths(["$(id)"])).rejects.toThrow(/Invalid path pattern/);
    await expect(agent.resolvePaths(["relative/*"])).rejects.toThrow(/Invalid path pattern/);
    expect(sent).toEqual([]);
});
