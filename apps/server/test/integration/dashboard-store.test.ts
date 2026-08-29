import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DashboardWidgetInstance } from "@central/shared";
import { DASHBOARD_MAX_CONFIG_BYTES, DASHBOARD_MAX_WIDGETS } from "@central/shared";
import { DashboardStore } from "../../src/features/dashboard/store";

// The dashboard store is the one place the control plane touches a host's widget
// arrangement. What it validates is structure only — `config` is a widget-defined
// blob the server has no schema for (doc/idea_host_dashboard.md §3) — so these
// pin the boundary: what a bad client can't write, and what a good one can.

async function freshStore(): Promise<DashboardStore> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-dash-"));
    const store = new DashboardStore(dir);
    await store.init();
    return store;
}

function widget(over: Partial<DashboardWidgetInstance> = {}): DashboardWidgetInstance {
    return { id: "a", widget: "system.cpu", span: 1, ...over };
}

test("a host with no stored layout reads back null, so the client can default it", async () => {
    const store = await freshStore();
    expect(store.get("host-1")).toBeNull();
});

test("saved layouts round-trip through a fresh store instance", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-dash-"));
    const store = new DashboardStore(dir);
    await store.init();
    await store.set("host-1", [widget(), widget({ id: "b", widget: "docker.stacks", span: 2 })]);

    const reloaded = new DashboardStore(dir);
    await reloaded.init();
    const dashboard = reloaded.get("host-1");
    expect(dashboard?.widgets.map((w) => w.widget)).toEqual(["system.cpu", "docker.stacks"]);
    expect(dashboard?.widgets[1].span).toBe(2);
    expect(reloaded.get("host-2")).toBeNull();
});

test("widget config is stored verbatim — the server never interprets it", async () => {
    const store = await freshStore();
    await store.set("host-1", [widget({ widget: "docker.stack", config: { project: "jellyfin", nested: { x: 1 } } })]);
    expect(store.get("host-1")?.widgets[0].config).toEqual({ project: "jellyfin", nested: { x: 1 } });
});

test("reset drops the row so the host falls back to the default, unlike an empty layout", async () => {
    const store = await freshStore();
    await store.set("host-1", [widget()]);
    await store.reset("host-1");
    expect(store.get("host-1")).toBeNull();

    // An empty widget list is a real arrangement ("show me nothing"), and must
    // not be confused with never having been arranged.
    await store.set("host-1", []);
    expect(store.get("host-1")?.widgets).toEqual([]);
});

test("structural validation rejects what would produce an unrenderable layout", async () => {
    const store = await freshStore();
    await expect(store.set("host-1", [widget({ id: "" })])).rejects.toThrow(/instance id/);
    await expect(store.set("host-1", [widget(), widget()])).rejects.toThrow(/Duplicate/);
    await expect(store.set("host-1", [widget({ widget: "" })])).rejects.toThrow(/names no widget/);
    await expect(store.set("host-1", [widget({ span: 4 as never })])).rejects.toThrow(/invalid span/);
    await expect(store.set("host-1", [widget({ config: [] as never })])).rejects.toThrow(/must be an object/);
    // A rejected save leaves the previous state alone.
    expect(store.get("host-1")).toBeNull();
});

test("size caps bound what a client can write into the state file", async () => {
    const store = await freshStore();
    const tooMany = Array.from({ length: DASHBOARD_MAX_WIDGETS + 1 }, (_, i) => widget({ id: `w${i}` }));
    await expect(store.set("host-1", tooMany)).rejects.toThrow(/at most/);

    const huge = { blob: "x".repeat(DASHBOARD_MAX_CONFIG_BYTES) };
    await expect(store.set("host-1", [widget({ config: huge })])).rejects.toThrow(/too large/);
});
