import type {
    TaskCmd,
    TaskCmdResult,
    TaskDockerContainerAction,
    TaskDockerContainerActionResult,
    TaskDockerImagePull,
    TaskDockerImagePullResult,
    TaskDockerStackAction,
    TaskDockerStackActionResult,
    TaskFindWanIp,
    TaskFindWanIpResult,
    TaskResult,
    TaskServiceAction,
    TaskServiceActionResult,
    TaskSpec,
    TaskUpdateAgent,
    TaskUpdateAgentResult,
} from "@central/shared";
import { AGENT_VERSION } from "@central/shared";
import type { Fleet } from "../fleet";
import type { HostAgent } from "../host-agent";
import { discoverWanIp } from "../stun";
import { dockerContainerAction, dockerImagePull, dockerStackAction } from "../docker";
import { systemdServiceAction } from "../systemd";

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
 * reported. `agent` is the resolved target host at the moment the run started,
 * or null for control-plane-local runs. `fleet`/`target` are exposed alongside
 * it only for kinds that need to *re-resolve* the target later in the same run
 * (e.g. `update_agent` waiting for the host to reconnect as a new connection) —
 * most handlers should just use `agent` and never touch `fleet` directly.
 */
export interface TaskCtx {
    log(text: string, stream?: "stdout" | "stderr"): void;
    signal: AbortSignal;
    agent: HostAgent | null;
    target: string | null;
    fleet: Fleet;
}

/** Cooperative sleep — resolves early (without throwing) if the run is aborted,
 *  so a polling loop's own `while` condition is what actually stops it. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
}

const RECONNECT_POLL_MS = 2_000;
const RECONNECT_TIMEOUT_MS = 5 * 60_000;

/**
 * Wait for the agent to come back as a *new* connection (proof it actually
 * disconnected to swap its binary and restart, not just still being the old
 * process) — polling `fleet.get` since the old `HostAgent` object is gone from
 * the fleet the moment it disconnects and won't itself flip back online.
 * Version-checked when possible, but a `force` re-push (same version string,
 * rebuilt binary) can't be told apart from the old connection that way, so it
 * settles for "a new connection came back online" instead.
 */
async function waitForAgentReconnect(ctx: TaskCtx, target: string, before: HostAgent, expectedVersion: string, force: boolean | undefined): Promise<void> {
    const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (ctx.signal.aborted) {
            throw new Error("Cancelled");
        }
        await sleep(RECONNECT_POLL_MS, ctx.signal);
        let agent: HostAgent;
        try {
            agent = ctx.fleet.get(target);
        } catch {
            continue; // mid-reconnect gap: deregistered, not yet re-registered
        }
        if (agent === before || agent.status().state !== "online") {
            continue;
        }
        // A new, online connection for this machine IS the reconnect — it's not
        // going to spontaneously change version from here, so a mismatch is the
        // final answer, not a "still settling" state worth continuing to poll for.
        const reportedVersion = agent.status().info?.agentVersion;
        if (!force && reportedVersion !== expectedVersion) {
            throw new Error(`Agent reconnected on ${reportedVersion ?? "an unknown version"}, expected ${expectedVersion}`);
        }
        return;
    }
    throw new Error(`Agent did not reconnect within ${Math.round(RECONNECT_TIMEOUT_MS / 1000)}s of the update being pushed`);
}

/**
 * One handler per task kind. The return type is pinned to that kind's result
 * variant, so spec and result can't drift. Mirrors `ApiHandlerPrefixed` but
 * keyed by `kind` instead of operation name.
 */
export interface TaskHandlers {
    cmd(spec: TaskCmd, ctx: TaskCtx): Promise<TaskCmdResult>;
    find_wan_ip(spec: TaskFindWanIp, ctx: TaskCtx): Promise<TaskFindWanIpResult>;
    service_action(spec: TaskServiceAction, ctx: TaskCtx): Promise<TaskServiceActionResult>;
    docker_stack_action(spec: TaskDockerStackAction, ctx: TaskCtx): Promise<TaskDockerStackActionResult>;
    docker_container_action(spec: TaskDockerContainerAction, ctx: TaskCtx): Promise<TaskDockerContainerActionResult>;
    docker_image_pull(spec: TaskDockerImagePull, ctx: TaskCtx): Promise<TaskDockerImagePullResult>;
    update_agent(spec: TaskUpdateAgent, ctx: TaskCtx): Promise<TaskUpdateAgentResult>;
}

/** Every kind below requires a target host — thrown as a normal task failure
 *  if a caller ever sends one with `target: null`. */
function requireAgent(ctx: TaskCtx, kind: string): HostAgent {
    if (!ctx.agent) {
        throw new Error(`${kind} requires a target host`);
    }
    return ctx.agent;
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

    async find_wan_ip(_spec, ctx) {
        // Targeted: STUN from the agent's own host (its network vantage point).
        // Untargeted: STUN from the control plane itself.
        const { ip } = ctx.agent ? await ctx.agent.discoverStun() : { ip: await discoverWanIp() };
        return { kind: "find_wan_ip", ip };
    },

    async service_action(spec, ctx) {
        await systemdServiceAction(requireAgent(ctx, "service_action"), spec.unit, spec.action, ctx.log);
        return { kind: "service_action" };
    },

    async docker_stack_action(spec, ctx) {
        await dockerStackAction(requireAgent(ctx, "docker_stack_action"), spec.project, spec.action, ctx.log);
        return { kind: "docker_stack_action" };
    },

    async docker_container_action(spec, ctx) {
        await dockerContainerAction(requireAgent(ctx, "docker_container_action"), spec.containerId, spec.action, ctx.log);
        return { kind: "docker_container_action" };
    },

    async docker_image_pull(spec, ctx) {
        const { ok, message } = await dockerImagePull(requireAgent(ctx, "docker_image_pull"), spec.ref, ctx.log);
        return { kind: "docker_image_pull", ok, message };
    },

    async update_agent(spec, ctx) {
        const agent = requireAgent(ctx, "update_agent");
        const current = agent.status().info?.agentVersion;
        if (agent.status().state !== "online") {
            throw new Error("Agent is not connected");
        }
        if (agent.mode !== "installed") {
            throw new Error("Only installed agents can be updated");
        }
        if (current === AGENT_VERSION && !spec.force) {
            throw new Error("Agent is already up to date");
        }
        if (!ctx.target) {
            throw new Error("update_agent requires a target host");
        }
        ctx.log(`Updating ${current ?? "unknown"} -> ${AGENT_VERSION}${spec.force ? " (forced)" : ""}`);
        await agent.updateService(AGENT_VERSION, spec.force);
        ctx.log("Update acknowledged by agent; waiting for it to reconnect on the new binary...");
        await waitForAgentReconnect(ctx, ctx.target, agent, AGENT_VERSION, spec.force);
        ctx.log("Agent reconnected — update complete.");
        return { kind: "update_agent" };
    },
};

/** Run a spec by dispatching to its handler. */
export function runTaskSpec(spec: TaskSpec, ctx: TaskCtx): Promise<TaskResult> {
    // The cast is the one unavoidable bridge between the value-level dispatch and
    // the type-level kind→handler map; each branch is still individually checked.
    return (taskHandlers[spec.kind] as (s: TaskSpec, c: TaskCtx) => Promise<TaskResult>)(spec, ctx);
}
