import { expect, test } from "bun:test";
import type { TaskRun } from "@central/shared";
import { AGENT_VERSION } from "@central/shared";
import { takePendingUpdate, writePendingUpdate, writeTaskState } from "../../src/config";
import { interruptedUpdateResolver } from "../../src/server-install";
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

// The one kind that is *meant* to be orphaned: `update_control_plane` exits the
// process on purpose and leaves a marker (pending-update.json) naming its run
// and the version it installed. The next boot settles that run from the marker
// — success if it's what's now running, a version-mismatch failure otherwise —
// and treats any other orphan of the kind, or one with no marker, as the
// generic interruption above. The marker is one-shot: taken on the boot it
// was meant for, gone by the next.

function updateRun(id: string): TaskRun {
    return run(id, "running", { spec: { kind: "update_control_plane" }, startedAt: 1_500 });
}

test("a self-update run settles as succeeded when the marked version is the one running", async () => {
    await writeTaskState([updateRun("upd"), run("other", "running", { startedAt: 1_600 })]);
    await writePendingUpdate({ runId: "upd", version: AGENT_VERSION });

    const store = new TaskStore();
    await store.init(await interruptedUpdateResolver());

    const settled = store.get("upd");
    expect(settled?.status).toBe("succeeded");
    expect(settled?.result).toEqual({ kind: "update_control_plane", version: AGENT_VERSION });
    expect(settled?.finishedAt).toBeNumber();
    // Only the marked run is vouched for; anything else is still an interruption.
    expect(store.get("other")?.status).toBe("failed");
    expect(store.get("other")?.error).toContain("control-plane restart");
    // One shot: the marker is gone, so a second boot sees nothing pending.
    expect(await takePendingUpdate()).toBeNull();
});

test("a self-update run fails, naming both versions, when a different version came up", async () => {
    await writeTaskState([updateRun("upd")]);
    await writePendingUpdate({ runId: "upd", version: "99.99.99" });

    const store = new TaskStore();
    await store.init(await interruptedUpdateResolver());

    const settled = store.get("upd");
    expect(settled?.status).toBe("failed");
    expect(settled?.error).toContain("99.99.99");
    expect(settled?.error).toContain(AGENT_VERSION);
});

test("a self-update run with no marker, or a marker for another run, is an ordinary interruption", async () => {
    await writeTaskState([updateRun("unmarked")]);
    let store = new TaskStore();
    await store.init(await interruptedUpdateResolver());
    expect(store.get("unmarked")?.status).toBe("failed");
    expect(store.get("unmarked")?.error).toContain("control-plane restart");

    await writeTaskState([updateRun("unmarked")]);
    await writePendingUpdate({ runId: "someone-else", version: AGENT_VERSION });
    store = new TaskStore();
    await store.init(await interruptedUpdateResolver());
    expect(store.get("unmarked")?.status).toBe("failed");
    expect(store.get("unmarked")?.error).toContain("control-plane restart");
    // Consumed regardless — a stale marker must not settle some future run.
    expect(await takePendingUpdate()).toBeNull();
});
