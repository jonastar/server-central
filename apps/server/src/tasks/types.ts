import type { TaskCmd, TaskFindWanIp, TaskCmdResult, TaskFindWanIpResult, TaskSpec, TaskResult } from "@central/shared";
import type { HostAgent } from "../host-agent";
import { discoverWanIp } from "../stun";

// ---- Task handlers: the server half of the spec union ------------------------
//
// The wire types in @central/shared are the spec (`TaskSpec`) and result
// (`TaskResult`) unions. This file is the runtime half: one handler per kind,
// the same shape as the API's operation handlers. The runner narrows on
// `spec.kind` and dispatches to `handlers[kind]`, so every kind is exhaustively
// covered at compile time — add a variant to `TaskSpec` and this map won't
// typecheck until its handler exists.

/**
 * Context a handler runs with. `log` is a no-op-cheap append that only matters
 * for kinds that stream output (e.g. `cmd`); the runner persists whatever's
 * reported. `agent` is the resolved target host, or null for control-plane-local
 * runs — handlers never touch the fleet directly.
 */
export interface TaskCtx {
    log(text: string, stream?: "stdout" | "stderr"): void;
    signal: AbortSignal;
    agent: HostAgent | null;
}

/**
 * One handler per task kind. The return type is pinned to that kind's result
 * variant, so spec and result can't drift. Mirrors `ApiHandlerPrefixed` but
 * keyed by `kind` instead of operation name.
 */
export interface TaskHandlers {
    cmd(spec: TaskCmd, ctx: TaskCtx): Promise<TaskCmdResult>;
    find_wan_ip(spec: TaskFindWanIp, ctx: TaskCtx): Promise<TaskFindWanIpResult>;
}

/** Generic dispatch: narrows the result to the spec's kind. */
export type TaskHandlerFor<K extends TaskSpec["kind"]> = TaskHandlers[K];

/**
 * The registry. Each handler is small and self-contained; the runner owns
 * status transitions, persistence, logs, and cancellation around them.
 */
export const taskHandlers: TaskHandlers = {
    async cmd(spec, ctx) {
        // Runs against ctx.agent when targeted, else on the control plane host.
        const res = ctx.agent
            ? await ctx.agent.exec(spec.command)
            : { stdout: "", stderr: "", code: 0 }; // control-plane exec TBD
        ctx.log(res.stdout);
        if (res.stderr) {
            ctx.log(res.stderr, "stderr");
        }
        return { kind: "cmd", exitCode: res.code, stdout: res.stdout, stderr: res.stderr };
    },

    async find_wan_ip(_spec, _ctx) {
        // Control-plane-local STUN. (next.md item 13 wants a per-node variant
        // too; that becomes an agent-targeted branch later.)
        return { kind: "find_wan_ip", ip: await discoverWanIp() };
    },
};

/** Run a spec by dispatching to its handler. */
export function runTaskSpec(spec: TaskSpec, ctx: TaskCtx): Promise<TaskResult> {
    // The cast is the one unavoidable bridge between the value-level dispatch and
    // the type-level kind→handler map; each branch is still individually checked.
    return (taskHandlers[spec.kind] as (s: TaskSpec, c: TaskCtx) => Promise<TaskResult>)(spec, ctx);
}
