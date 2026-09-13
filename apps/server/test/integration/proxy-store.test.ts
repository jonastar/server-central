import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ProxyRoute } from "@central/shared";
import { ProxyStore } from "../../src/features/proxy/store";

// The store is where a route that can't render gets refused, before it can
// take the whole config down with it — the Caddy config is pushed as one
// document, so one bad route is every route. Container targets are the case:
// they only render on the proxy node until the cross-node tunnel exists.

async function freshStore(seed?: object): Promise<ProxyStore> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-proxy-store-"));
    if (seed) {
        await fs.writeFile(path.join(dir, "proxy.json"), JSON.stringify(seed));
    }
    const store = new ProxyStore(dir);
    await store.init();
    return store;
}

const container = (nodeId: string): ProxyRoute["target"] =>
    ({ kind: "container", nodeId, stackId: "s1", service: "jellyfin", alias: "media-jellyfin", port: 8096, scheme: "http" });

test("container routes are accepted on the proxy node and refused elsewhere", async () => {
    const store = await freshStore();
    await store.setConfig({ nodeId: "node-a", certMode: "auto" });

    await store.createRoute({ host: "jf.example.com", target: container("node-a"), enabled: true });
    await expect(store.createRoute({ host: "jf2.example.com", target: container("node-b"), enabled: true }))
        .rejects.toThrow(/proxy node/);
    // Host ports keep working from any node — that's the cross-node path today.
    await store.createRoute({ host: "hp.example.com", target: { kind: "hostPort", nodeId: "node-b", port: 8096, scheme: "http" }, enabled: true });
    expect(store.routes).toHaveLength(2);
});

test("moving the proxy is refused while container routes would be stranded on the old node", async () => {
    const store = await freshStore();
    await store.setConfig({ nodeId: "node-a", certMode: "auto" });
    await store.createRoute({ host: "jf.example.com", target: container("node-a"), enabled: true });

    await expect(store.setConfig({ nodeId: "node-b", certMode: "auto" })).rejects.toThrow(/container route/);
    // Same node, other settings: fine.
    await store.setConfig({ nodeId: "node-a", certMode: "internal" });
    expect(store.config?.certMode).toBe("internal");
});

test("a container target needs a well-formed alias and its stack/service provenance", async () => {
    const store = await freshStore();
    await store.setConfig({ nodeId: "node-a", certMode: "auto" });
    await expect(store.createRoute({ host: "a.example.com", target: { ...container("node-a"), alias: "media jellyfin" }, enabled: true }))
        .rejects.toThrow(/alias/);
    await expect(store.createRoute({ host: "a.example.com", target: { ...container("node-a"), service: "" }, enabled: true }))
        .rejects.toThrow(/stack and a service/);
});

test("routes persisted before targets had a kind load as host ports", async () => {
    const store = await freshStore({
        config: { nodeId: "node-a", certMode: "auto" },
        routes: [{ id: "r1", host: "old.example.com", target: { nodeId: "node-b", port: 80, scheme: "http" }, enabled: true }],
        lastApply: null,
    });
    expect(store.routes[0].target.kind).toBe("hostPort");
});
