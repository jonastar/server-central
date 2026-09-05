import type { TaskCmd, TaskCmdResult, TaskExec, TaskExecResult, UserInfo } from "@central/shared";
import { dockerContainerShellCommand } from "../docker/docker";
import { resolveShellUser } from "../system-users/system-users";
import { defineFeature } from "../../feature";
import type { Fleet } from "../../fleet";
import type { ExecOptions, ExecResult, ShellSession } from "../../host-agent";
import { runStreamingLines } from "../../exec-lines";
import type { TaskCtx } from "../../tasks/types";

export const createTerminalFeature = () => defineFeature({
    id: "terminal",
    name: "Terminal",
    description: "Interactive shell sessions into a host or container.",
    experimental: false,
    tasks: {
        /**
         * The one place in the codebase that still hands a shell a command string,
         * and the one place where that's the feature rather than an oversight: the
         * command is free text an operator typed, `panel.exec` already means
         * terminal access, and pipes and redirects are what they're asking for.
         *
         * It goes through the same argv path as everything else — the shell is now
         * named in the argv (`sh -c <command>`) instead of being what the host does
         * to a string by default. Anything the control plane *builds* uses `exec`
         * below, where a value can't turn into syntax.
         */
        async cmd(spec: TaskCmd, ctx: TaskCtx): Promise<TaskCmdResult> {
            const res = await runForTask(ctx, ["sh", "-c", spec.command]);
            return { kind: "cmd", exitCode: res.code, stdout: res.stdout, stderr: res.stderr };
        },

        async exec(spec: TaskExec, ctx: TaskCtx): Promise<TaskExecResult> {
            if (spec.argv.length === 0) {
                throw new Error("An exec task needs a command to run");
            }
            const res = await runForTask(ctx, spec.argv, { cwd: spec.cwd, env: spec.env });
            return { kind: "exec", exitCode: res.code, stdout: res.stdout, stderr: res.stderr };
        },
    },
});

// ---- Task kinds --------------------------------------------------------------
//
// `cmd` and `exec` live here because `panel.exec` — the permission both require —
// is documented as "equivalent to terminal access": they are the non-interactive
// form of what this feature offers interactively, and reach the same root shell.


/**
 * Run a command for a task, with its output reaching the run's log as it
 * appears rather than all at once at the end. Runs against `ctx.agent` when the
 * task is targeted at a host.
 */
async function runForTask(ctx: TaskCtx, argv: string[], opts?: ExecOptions): Promise<ExecResult> {
    if (!ctx.agent) {
        return { stdout: "", stderr: "", code: 0 }; // control-plane exec TBD
    }
    return runStreamingLines(ctx.agent, argv, (text, stream) => ctx.log(text, stream), opts);
}

/**
 * Resolves and opens the PTY session for a `/terminal` WebSocket connection.
 * The connection lifecycle itself (open/message/close, `WsData`) stays
 * hand-written in index.ts — same precedent as routes.ts's hash-parsing in
 * the frontend design doc: one global concern, genuinely intertwined with the
 * single `Bun.serve` instance, not per-feature boilerplate.
 */
export async function openTerminalShell(fleet: Fleet, serverId: string, containerId: string | null, user: UserInfo): Promise<ShellSession> {
    const agent = fleet.get(serverId);
    return containerId
        // Container terminals run whatever `docker exec` resolves to inside
        // the container — a separate identity boundary from the host OS
        // user mapping below, same as the existing one-shot docker exec.
        ? agent.openShell(80, 24, null, dockerContainerShellCommand(containerId))
        // Host terminals run as the caller's mapped OS account; unmapped
        // operator/viewer accounts are refused here (null = agent's own user, root).
        : agent.openShell(80, 24, resolveShellUser(user));
}
