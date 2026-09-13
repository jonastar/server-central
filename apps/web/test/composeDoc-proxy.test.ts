import { expect, test } from "bun:test";
import { attachToProxyNetwork, detachFromProxyNetwork, parseCompose, serviceProxyAlias, serviceProxyPorts, stringifyCompose, withImagePorts } from "../src/lib/composeDoc";

// Attaching a service to the proxy network is a compose-file edit SC makes on
// the operator's behalf, so what it writes has to be exactly what a careful
// author would: the external declaration, the alias, and — the part that bites
// — `default` kept for a service that never named its networks.

const plain = `services:
  jellyfin:
    image: jellyfin/jellyfin
    ports:
      - "8096:8096"
  db:
    image: postgres
`;

test("a service with no networks keeps default when it joins the proxy network", () => {
    const doc = parseCompose(plain);
    attachToProxyNetwork(doc, "jellyfin", "media-jellyfin");
    const out = doc.toJS() as { networks: Record<string, unknown>; services: Record<string, { networks?: unknown }> };
    expect(out.networks).toEqual({ "sc-proxy": { external: true } });
    expect(out.services.jellyfin.networks).toEqual({ default: {}, "sc-proxy": { aliases: ["media-jellyfin"] } });
    // The sibling is untouched.
    expect(out.services.db.networks).toBeUndefined();
    expect(serviceProxyAlias(doc, "jellyfin")).toBe("media-jellyfin");
    expect(serviceProxyAlias(doc, "db")).toBeNull();
});

test("a list-form networks entry becomes the map form with the author's networks intact", () => {
    const doc = parseCompose(`services:
  app:
    image: x
    networks:
      - backend
networks:
  backend: {}
`);
    attachToProxyNetwork(doc, "app", "stack-app");
    const out = doc.toJS() as { networks: Record<string, unknown>; services: { app: { networks: Record<string, unknown> } } };
    // Not on default before, not on default after.
    expect(Object.keys(out.services.app.networks)).toEqual(["backend", "sc-proxy"]);
    expect(out.networks).toEqual({ backend: {}, "sc-proxy": { external: true } });
});

test("re-attaching under a new alias replaces the old one and leaves the rest alone", () => {
    const doc = parseCompose(plain);
    attachToProxyNetwork(doc, "jellyfin", "old-jellyfin");
    attachToProxyNetwork(doc, "jellyfin", "media-jellyfin");
    expect(serviceProxyAlias(doc, "jellyfin")).toBe("media-jellyfin");
    const text = stringifyCompose(doc);
    expect(text.match(/sc-proxy:/g)?.length).toBe(2); // one top-level, one on the service
});

test("network_mode services can't be attached", () => {
    const doc = parseCompose(`services:\n  app:\n    image: x\n    network_mode: host\n`);
    expect(() => attachToProxyNetwork(doc, "app", "s-app")).toThrow(/network_mode/);
});

test("detaching undoes the attach, down to the top-level declaration", () => {
    const doc = parseCompose(plain);
    attachToProxyNetwork(doc, "jellyfin", "media-jellyfin");
    attachToProxyNetwork(doc, "db", "media-db");
    detachFromProxyNetwork(doc, "jellyfin");
    let out = doc.toJS() as { networks?: unknown; services: Record<string, { networks?: unknown }> };
    expect(out.services.jellyfin.networks).toBeUndefined();
    // db still uses it, so the declaration stays.
    expect(out.networks).toEqual({ "sc-proxy": { external: true } });
    detachFromProxyNetwork(doc, "db");
    out = doc.toJS() as typeof out;
    expect(out.networks).toBeUndefined();
    expect(stringifyCompose(doc)).toBe(plain);
});

test("port candidates: ports (named, published) first, then expose, deduped", () => {
    const doc = parseCompose(`services:
  app:
    image: x
    ports:
      - "8096:8096"
      - target: 8920
        published: 8920
        name: web-https
      - "1900:1900/udp"
    expose:
      - "8096"
      - 9000
      - "9001/tcp"
`);
    expect(serviceProxyPorts(doc, "app")).toEqual([
        { port: 8096, source: "ports", published: "8096" },
        { port: 8920, source: "ports", name: "web-https", published: "8920" },
        { port: 9000, source: "expose" },
        { port: 9001, source: "expose" },
    ]);
    expect(serviceProxyPorts(doc, "nope")).toEqual([]);
});

test("image EXPOSE ports fill in after the compose file's, tcp only, no duplicates", () => {
    const declared = serviceProxyPorts(parseCompose(`services:\n  app:\n    image: x\n    ports:\n      - "8096:8096"\n`), "app");
    const merged = withImagePorts(declared, [
        { port: 8096, protocol: "tcp" },
        { port: 1900, protocol: "udp" },
        { port: 8920, protocol: "tcp" },
    ]);
    expect(merged).toEqual([
        { port: 8096, source: "ports", published: "8096" },
        { port: 8920, source: "image" },
    ]);
});
