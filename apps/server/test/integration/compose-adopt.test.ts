import { expect, test } from "bun:test";
import type { DockerStack } from "@central/shared";
import { ComposeStackStore } from "../../src/features/compose/store";
import { Fleet } from "../../src/fleet";

// `ComposeStackStore.syncHost` is what turns "SC sees this compose project
// running" into "SC manages this compose project", on every read of a host's
// Compose stacks section. It's pure bookkeeping over the observed list — no
// agent calls, no host writes — so it's exercised directly here.
//
// Stores are deliberately built *without* `init()`: that would load whatever
// the shared per-run SC_DATA_DIR already holds (see test/env-preload.ts), and
// every case below wants a known-empty registry.

function observed(project: string, configFiles: string): DockerStack {
    return { project, containers: 2, running: 2, configFiles, states: ["running"] };
}

function newStore(): ComposeStackStore {
    return new ComposeStackStore(new Fleet(() => {}));
}

test("adopts an observed project, taking the project name from the label", async () => {
    const store = newStore();
    // Directory basename deliberately differs from the compose project name.
    // create()/import() would predict "media-box" from the directory here; an
    // adopted stack must keep "jellyfin", or every later `docker compose -p`
    // would address a project that doesn't exist.
    const stacks = await store.syncHost("h1", [observed("jellyfin", "/srv/media-box/docker-compose.yml")]);

    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.project).toBe("jellyfin");
    expect(stacks[0]!.name).toBe("jellyfin");
    expect(stacks[0]!.dir).toBe("/srv/media-box");
    expect(stacks[0]!.composeFile).toBe("docker-compose.yml");
    expect(stacks[0]!.hostId).toBe("h1");
});

test("adoption is idempotent — reading again adopts nothing new", async () => {
    const store = newStore();
    const first = await store.syncHost("h1", [observed("a", "/opt/a/compose.yaml")]);
    const second = await store.syncHost("h1", [observed("a", "/opt/a/compose.yaml")]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
});

test("skips projects whose containers carry no usable compose path", async () => {
    const store = newStore();
    // No label at all, and a relative path — meaningless without the cwd the
    // project was started from, which isn't recoverable after the fact.
    expect(await store.syncHost("h1", [observed("x", "")])).toHaveLength(0);
    expect(await store.syncHost("h1", [observed("y", "compose.yaml")])).toHaveLength(0);
    expect(await store.syncHost("h1", [observed("z", "  ")])).toHaveLength(0);
    expect(store.list()).toHaveLength(0);
});

test("multi-file projects adopt from the first -f path", async () => {
    const store = newStore();
    const stacks = await store.syncHost("h1", [
        observed("stackx", "/opt/stackx/compose.yaml,/opt/stackx/compose.override.yaml"),
    ]);

    expect(stacks[0]!.dir).toBe("/opt/stackx");
    expect(stacks[0]!.composeFile).toBe("compose.yaml");
});

test("the same project name on two hosts adopts as two separate stacks", async () => {
    const store = newStore();
    await store.syncHost("h1", [observed("dup", "/opt/dup/compose.yaml")]);
    const h2 = await store.syncHost("h2", [observed("dup", "/data/dup/compose.yaml")]);

    expect(h2).toHaveLength(1);
    expect(h2[0]!.dir).toBe("/data/dup");
    expect(store.list()).toHaveLength(2);
});

test("an already-registered project is left alone, name and all", async () => {
    const store = newStore();
    // Stand in for a stack imported through SC under an operator-chosen name.
    const imported = await store.syncHost("h1", [observed("jellyfin", "/srv/media/compose.yaml")]);
    const renamed = { ...imported[0]!, name: "Movies" };
    (store as unknown as { stacks: Map<string, unknown> }).stacks.set(renamed.id, renamed);

    const after = await store.syncHost("h1", [observed("jellyfin", "/srv/media/compose.yaml")]);

    expect(after).toHaveLength(1);
    expect(after[0]!.name).toBe("Movies");
});

test("only the host being synced is considered", async () => {
    const store = newStore();
    await store.syncHost("h1", [observed("shared-name", "/opt/one/compose.yaml")]);
    // h2 sees nothing running; h1's stack must not leak into its list.
    expect(await store.syncHost("h2", [])).toHaveLength(0);
    expect(await store.syncHost("h1", [])).toHaveLength(1);
});
