import type { TaskDebugFake, TaskDebugFakeResult } from "@central/shared";
import type { Feature, FeatureTaskHandlers } from "../../feature";
import type { TaskCtx } from "../../tasks/types";

// A feature that does nothing to the machine, on purpose: it owns the one
// synthetic task kind, so the task UI (corner widget, live modal, run history)
// can be driven on demand instead of by hunting for a real slow action to
// trigger. Owner-only — a development affordance, not something everyone signed
// in should be able to fill the run history with.

export function createDebugFeature(): Feature<never, "debug_fake"> {
    return {
        descriptor: {
            id: "debug",
            name: "Debug",
            description: "Synthetic tasks for exercising the task UI without touching a host.",
            experimental: true,
        },
        taskHandlers() {
            return debugTaskHandlers();
        },
        ownerOnlyTaskKinds: ["debug_fake"],
    };
}

/** Bounds a caller can't talk us out of: a fake run must not be able to sit in
 *  the runner for an hour, or spin out thousands of log lines a second. */
const MAX_DURATION_MS = 5 * 60_000;
const MIN_INTERVAL_MS = 50;

/** Cooperative sleep — resolves early (without throwing) if the run is aborted,
 *  so the loop's own condition is what stops it. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
}

/** SGR prefix, spelled as an escape so no raw control byte sits in this file. */
const SGR = "\u001b[";

/** Rotating filler, so the log pane gets varied content — a line long enough to
 *  wrap, ANSI to colorize, the occasional stderr line — rather than one string
 *  repeated, which would hide every rendering bug worth catching here. */
const CHATTER: Array<{ text: string; stream?: "stdout" | "stderr" }> = [
    { text: "Resolving dependency graph..." },
    { text: `${SGR}32m[ok]${SGR}0m layer 4f2c9a1 pulled` },
    { text: "warning: falling back to the slow path for this step", stream: "stderr" },
    { text: `Copying ${"a-very/long/path/that/should/wrap-or-scroll/".repeat(4)}payload.tar.gz` },
    { text: `${SGR}33m[~]${SGR}0m reusing cached artifact` },
    { text: "Applying configuration" },
    { text: "error: transient failure, retrying (1/3)", stream: "stderr" },
    { text: `${SGR}36mstep${SGR}0m committed` },
];

export function debugTaskHandlers(): FeatureTaskHandlers<"debug_fake"> {
    return {
        async debug_fake(spec: TaskDebugFake, ctx: TaskCtx): Promise<TaskDebugFakeResult> {
            const duration = Math.min(Math.max(0, spec.durationMs), MAX_DURATION_MS);
            const interval = Math.max(MIN_INTERVAL_MS, spec.intervalMs);
            const startedAt = Date.now();

            ctx.log(`Fake task started — running for ${(duration / 1000).toFixed(1)}s, one line every ${interval}ms`);
            let lines = 1;

            for (;;) {
                const elapsed = Date.now() - startedAt;
                if (elapsed >= duration) {
                    break;
                }
                await sleep(Math.min(interval, duration - elapsed), ctx.signal);
                if (ctx.signal.aborted) {
                    throw new Error("Cancelled");
                }
                const chatter = CHATTER[lines % CHATTER.length]!;
                ctx.log(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${chatter.text}`, chatter.stream);
                lines++;
            }

            if (spec.fail) {
                ctx.log("Failing on request.", "stderr");
                throw new Error(`Fake task failed on request after ${lines} log lines`);
            }
            ctx.log(`Fake task finished after ${lines + 1} log lines.`);
            return { kind: "debug_fake", lines: lines + 1 };
        },
    };
}
