import { expect, test } from "bun:test";
import { TASK_KIND_PERMISSIONS } from "@central/shared";
import type { Fleet } from "../../src/fleet";
import type { ExecOptions, HostAgent } from "../../src/host-agent";
import type { TaskCtx } from "../../src/tasks/types";
import { createTerminalFeature } from "../../src/features/terminal/feature";

// The handlers are declared inside the feature now; this is how a test reaches them.
const taskHandlers = createTerminalFeature().taskHandlers!();

// Two task kinds, one power. `exec` takes an argv so a caller that *builds* a
// command can't turn a value into syntax; `cmd` takes a command line for the
// case where a person typed one and the pipes are the point. Both are
// `panel.exec`, which already means terminal access — the split is about which
// is easy to get wrong, not about privilege.

function makeCtx(chunks: [stream: "stdout" | "stderr", data: string][] = [], code = 0) {
    const ran: { argv: string[]; opts?: ExecOptions }[] = [];
    const logged: string[] = [];
    const agent = {
        runStream: async (argv: string[], onChunk: (s: "stdout" | "stderr", d: string) => void, opts?: ExecOptions) => {
            ran.push({ argv, opts });
            const acc = { stdout: "", stderr: "" };
            for (const [stream, data] of chunks) {
                acc[stream] += data;
                onChunk(stream, data);
            }
            return { ...acc, code };
        },
    } as unknown as HostAgent;

    const ctx: TaskCtx = {
        log: (text, stream) => logged.push(`${stream ?? "stdout"}:${text}`),
        signal: new AbortController().signal,
        agent,
        target: "node-a",
        fleet: {} as Fleet,
    };
    return { ctx, ran, logged };
}

test("an exec task's argv reaches the host verbatim", async () => {
    const { ctx, ran } = makeCtx();
    const res = await taskHandlers.exec(
        { kind: "exec", argv: ["tar", "-xf", "a file && rm -rf /.tar"], cwd: "/srv", env: { LANG: "C" } },
        ctx,
    );
    expect(ran[0].argv).toEqual(["tar", "-xf", "a file && rm -rf /.tar"]);
    expect(ran[0].opts).toEqual({ cwd: "/srv", env: { LANG: "C" } });
    expect(res).toEqual({ kind: "exec", exitCode: 0, stdout: "", stderr: "" });
});

test("a cmd task names the shell in its argv instead of relying on one", async () => {
    const { ctx, ran } = makeCtx();
    await taskHandlers.cmd({ kind: "cmd", command: "docker ps | grep web" }, ctx);
    // The command line is one argument to `sh`, not a string the host re-parses
    // on its own — the shell is deliberate and visible.
    expect(ran[0].argv).toEqual(["sh", "-c", "docker ps | grep web"]);
});

test("output reaches the run log a line at a time, tagged with its stream", async () => {
    const { ctx, logged } = makeCtx([
        ["stdout", "first\nsec"],
        ["stderr", "a warning\n"],
        ["stdout", "ond\nthird\n"],
    ]);
    const res = await taskHandlers.exec({ kind: "exec", argv: ["build"] }, ctx);

    // "sec"+"ond" is one line despite arriving in two chunks, and the stderr
    // chunk in between doesn't get spliced into the middle of it.
    expect(logged).toEqual([
        "stdout:first",
        "stderr:a warning",
        "stdout:second",
        "stdout:third",
    ]);
    expect(res.stdout).toBe("first\nsecond\nthird\n");
});

test("a non-zero exit is reported, not thrown — the caller wanted the output", async () => {
    const { ctx } = makeCtx([["stderr", "no such file\n"]], 2);
    const res = await taskHandlers.exec({ kind: "exec", argv: ["cat", "/nope"] }, ctx);
    expect(res).toMatchObject({ kind: "exec", exitCode: 2, stderr: "no such file\n" });
});

test("an empty argv is refused before anything runs", async () => {
    const { ctx, ran } = makeCtx();
    await expect(taskHandlers.exec({ kind: "exec", argv: [] }, ctx)).rejects.toThrow(/needs a command/);
    expect(ran).toEqual([]);
});

test("both kinds sit behind panel.exec", () => {
    expect(TASK_KIND_PERMISSIONS.exec).toBe("panel.exec");
    expect(TASK_KIND_PERMISSIONS.cmd).toBe("panel.exec");
});
