import { expect, test } from "bun:test";
import type { TaskRun } from "@central/shared";
import { writeTaskState } from "../../src/config";
import { TaskStore } from "../../src/tasks/store";

// `TaskRunner` persists every status transition, so a run that was in flight
// when the control plane stopped is on disk as `pending`/`running`. Nothing in a
// fresh process can ever complete it — the execution context that would write a
// terminal status died with the old one — so `TaskStore.init()` must resolve
// them on load or they show as "Running" forever.
//
// No sockets and no runner here: the whole contract is "what does init() do with
// what's on disk". This is the only test that touches `tasks.json` in the shared
// SC_DATA_DIR (see test/env-preload.ts), so it can own the file.

function run(id: string, status: TaskRun["status"], extra: Partial<TaskRun> = {}): TaskRun {
    return {
        id,
        spec: { kind: "find_wan_ip" },
        target: null,
        status,
        trigger: { kind: "manual" },
        createdAt: 1_000,
        ...extra,
    };
}

test("init() resolves runs orphaned by a restart and leaves terminal ones alone", async () => {
    const done = run("done", "succeeded", {
        startedAt: 3_100,
        finishedAt: 3_200,
        result: { kind: "find_wan_ip", ip: "1.2.3.4" },
    });
    await writeTaskState([
        run("was-running", "running", { startedAt: 1_500 }),
        run("was-pending", "pending"),
        done,
        run("was-failed", "failed", { startedAt: 4_000, finishedAt: 4_100, error: "boom" }),
    ]);

    const store = new TaskStore();
    await store.init();

    for (const id of ["was-running", "was-pending"]) {
        const reaped = store.get(id);
        expect(reaped?.status).toBe("failed");
        expect(reaped?.error).toContain("control-plane restart");
        // Must be set: the UI counts up from `startedAt` to now while it's
        // absent, so an unstamped run would show an ever-growing duration.
        expect(reaped?.finishedAt).toBeNumber();
    }

    // Terminal runs are untouched, error text and all.
    expect(store.get("done")).toEqual(done);
    expect(store.get("was-failed")?.error).toBe("boom");
});

test("reaping is persisted and idempotent across a second restart", async () => {
    await writeTaskState([run("orphan", "running", { startedAt: 1_500 })]);

    const first = new TaskStore();
    await first.init();
    const reaped = first.get("orphan");

    // A second boot reads what the first one wrote — already terminal, so it
    // must pass through unchanged rather than being re-stamped with a new
    // `finishedAt` on every restart.
    const second = new TaskStore();
    await second.init();
    expect(second.get("orphan")).toEqual(reaped);
});
