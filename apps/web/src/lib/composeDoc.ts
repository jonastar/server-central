import { Document, YAMLMap, YAMLSeq, isMap, isSeq, parseDocument } from "yaml";
import { PROXY_NETWORK } from "@central/shared";

/** CST-preserving parse — comments, key order, and formatting on untouched nodes
 *  survive a targeted `setIn`/seq mutation + re-stringify. */
export function parseCompose(text: string): Document {
    return parseDocument(text);
}

export function stringifyCompose(doc: Document): string {
    return doc.toString({ lineWidth: 0 });
}

function toJs<T>(node: unknown): T | undefined {
    if (node && typeof (node as { toJSON?: unknown }).toJSON === "function") {
        return (node as { toJSON(): T }).toJSON();
    }
    return node as T | undefined;
}

export function listServiceNames(doc: Document): string[] {
    const services = toJs<Record<string, unknown>>(doc.get("services"));
    return services ? Object.keys(services) : [];
}

export function getServiceField<T>(doc: Document, service: string, field: string): T | undefined {
    return toJs<T>(doc.getIn(["services", service, field]));
}

/**
 * Walks `path`, converting each segment into a real `YAMLMap` and returning the
 * deepest one. `Document#setIn` only auto-creates *missing* keys — a key present
 * with an explicit `null` value (e.g. a freshly scaffolded `services:\n`, or any
 * bare `key:` with nothing under it) makes it throw ("Expected YAML collection
 * at ..."), since `null` isn't a collection to descend into. This replaces such
 * placeholders with maps instead of erroring, which is what every writer here
 * needs since a new stack starts from exactly that empty scaffold.
 */
function ensureMapPath(doc: Document, path: (string | number)[]): YAMLMap {
    if (!isMap(doc.contents)) {
        doc.contents = new YAMLMap(doc.schema);
    }
    let node = doc.contents as YAMLMap;
    for (const seg of path) {
        const existing = node.get(seg, true);
        if (isMap(existing)) {
            node = existing;
            continue;
        }
        const fresh = new YAMLMap(doc.schema);
        node.set(seg, fresh);
        node = fresh;
    }
    return node;
}

export function setServiceField(doc: Document, service: string, field: string, value: unknown): void {
    if (value === undefined || value === "") {
        doc.deleteIn(["services", service, field]);
    } else {
        ensureMapPath(doc, ["services", service]).set(field, doc.createNode(value));
    }
}

/** Registers a new, empty service — the entry point for a document whose
 *  `services:` key doesn't exist as a map yet (see `ensureMapPath`). */
export function addService(doc: Document, name: string): void {
    ensureMapPath(doc, ["services"]).set(name, new YAMLMap(doc.schema));
}

function ensureSeq(doc: Document, path: (string | number)[]): YAMLSeq {
    const field = path[path.length - 1];
    const parent = ensureMapPath(doc, path.slice(0, -1));
    let node: unknown = parent.get(field, true);
    if (!isSeq(node)) {
        node = new YAMLSeq(doc.schema);
        parent.set(field, node);
    }
    return node as YAMLSeq;
}

/** Row-level helpers for array fields (`ports`, `volumes`) — mutate one item at a
 *  time via the real seq node so sibling items/comments are left untouched, rather
 *  than replacing the whole array on every edit. */
export function getSeqItems<T>(doc: Document, path: (string | number)[]): T[] {
    const seq = doc.getIn(path);
    return isSeq(seq) ? seq.items.map((item) => toJs<T>(item) as T) : [];
}

export function addSeqItem(doc: Document, path: (string | number)[], value: unknown): void {
    ensureSeq(doc, path).add(doc.createNode(value));
}

export function setSeqItem(doc: Document, path: (string | number)[], index: number, value: unknown): void {
    ensureSeq(doc, path).set(index, doc.createNode(value));
}

export function removeSeqItem(doc: Document, path: (string | number)[], index: number): void {
    const seq = doc.getIn(path);
    if (isSeq(seq)) {
        seq.delete(index);
    }
}

// ---- ports ------------------------------------------------------------------------

export interface PortRow {
    kind: "short" | "long" | "raw";
    published: string;
    target: string;
    protocol: "tcp" | "udp";
    /** compose's own `name` field on the long-form port object — a human label
     *  ("web", "web-admin", ...). Short-form syntax has no room for it, so any
     *  row with a name is always serialized long-form regardless of `kind`.
     *  The eventual reverse-proxy route picker can use this to let an operator
     *  pick "web" instead of a bare port number. */
    name: string;
    /** Entry couldn't be decomposed (host_ip prefix, port ranges, extra long-form
     *  keys) — shown read-only, edit via the YAML tab. */
    raw?: unknown;
}

const SHORT_PORT_RE = /^(?:(\d+):)?(\d+)(?:\/(tcp|udp))?$/;

export function parsePortEntry(entry: unknown): PortRow {
    if (typeof entry === "number") {
        return { kind: "short", published: "", target: String(entry), protocol: "tcp", name: "" };
    }
    if (typeof entry === "string") {
        const m = SHORT_PORT_RE.exec(entry);
        if (m) {
            return { kind: "short", published: m[1] ?? "", target: m[2], protocol: (m[3] as "tcp" | "udp") ?? "tcp", name: "" };
        }
        return { kind: "raw", published: "", target: "", protocol: "tcp", name: "", raw: entry };
    }
    if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        const extraKeys = Object.keys(o).some((k) => !["published", "target", "protocol", "name"].includes(k));
        if (extraKeys) {
            return { kind: "raw", published: "", target: "", protocol: "tcp", name: "", raw: o };
        }
        return {
            kind: "long",
            published: o.published !== undefined ? String(o.published) : "",
            target: o.target !== undefined ? String(o.target) : "",
            protocol: (o.protocol as "tcp" | "udp") ?? "tcp",
            name: (o.name as string | undefined) ?? "",
        };
    }
    return { kind: "raw", published: "", target: "", protocol: "tcp", name: "", raw: entry };
}

export function serializePortRow(row: PortRow): unknown {
    if (row.kind === "raw") {
        return row.raw;
    }
    if (row.kind === "long" || row.name) {
        const o: Record<string, unknown> = { target: row.target };
        if (row.published) {
            o.published = row.published;
        }
        if (row.protocol !== "tcp") {
            o.protocol = row.protocol;
        }
        if (row.name) {
            o.name = row.name;
        }
        return o;
    }
    const proto = row.protocol === "udp" ? "/udp" : "";
    return row.published ? `${row.published}:${row.target}${proto}` : `${row.target}${proto}`;
}

// ---- reverse proxy network ----------------------------------------------------
//
// A service becomes a proxy route target by joining the shared PROXY_NETWORK
// under a per-stack alias (doc/idea_reverse_proxy.md, v2 layer 3). These read
// and write exactly that: the top-level external network declaration and the
// service's `networks` block.

/** A port the route picker can offer for a service: what the container listens
 *  on, labelled by compose's `name` when the author gave it one. */
export interface ProxyPortCandidate {
    /** Container-side port. */
    port: number;
    name?: string;
    /** Host port it's also published on, when it is. Irrelevant to a container
     *  route — the proxy dials the container side — but worth showing. */
    published?: string;
    /** Where the port was declared: the compose file, or the image's own
     *  `EXPOSE` (see `withImagePorts`). */
    source: "ports" | "expose" | "image";
}

/**
 * Ports a service declares, `ports:` first and then `expose:`, one entry per
 * container port. `expose` matters here precisely because it *doesn't* publish:
 * it's the honest way to mark a port as proxy-only, and a service on the
 * proxy network needs no `ports:` entry at all to be reachable.
 */
export function serviceProxyPorts(doc: Document, service: string): ProxyPortCandidate[] {
    const out: ProxyPortCandidate[] = [];
    const seen = new Set<number>();
    for (const entry of getSeqItems<unknown>(doc, ["services", service, "ports"])) {
        const row = parsePortEntry(entry);
        const port = Number(row.target);
        if (row.kind === "raw" || row.protocol !== "tcp" || !Number.isInteger(port) || seen.has(port)) {
            continue;
        }
        seen.add(port);
        out.push({ port, source: "ports", ...(row.name ? { name: row.name } : {}), ...(row.published ? { published: row.published } : {}) });
    }
    for (const entry of getSeqItems<unknown>(doc, ["services", service, "expose"])) {
        const m = /^(\d+)(?:\/tcp)?$/.exec(String(entry));
        const port = m ? Number(m[1]) : NaN;
        if (!Number.isInteger(port) || seen.has(port)) {
            continue;
        }
        seen.add(port);
        out.push({ port, source: "expose" });
    }
    return out;
}

/**
 * The compose candidates plus what the image itself declares with `EXPOSE`
 * (`docker.imageDefaults`), for services whose compose file says nothing about
 * ports — on the proxy network there's no reason it would. Compose entries win
 * on duplicates: they may carry a name.
 */
export function withImagePorts(
    declared: ProxyPortCandidate[],
    image: { port: number; protocol: "tcp" | "udp" }[],
): ProxyPortCandidate[] {
    const seen = new Set(declared.map((c) => c.port));
    const extra = image
        .filter((p) => p.protocol === "tcp" && !seen.has(p.port))
        .map((p): ProxyPortCandidate => ({ port: p.port, source: "image" }));
    return [...declared, ...extra];
}

/** The alias a service carries on the proxy network; `null` when it isn't on
 *  it at all, `""` when it's attached without an alias (bare name only). */
export function serviceProxyAlias(doc: Document, service: string): string | null {
    const networks = getServiceField<unknown>(doc, service, "networks");
    if (Array.isArray(networks)) {
        return networks.includes(PROXY_NETWORK) ? "" : null;
    }
    if (networks && typeof networks === "object" && PROXY_NETWORK in networks) {
        const entry = (networks as Record<string, { aliases?: unknown } | null>)[PROXY_NETWORK];
        const aliases = entry?.aliases;
        return Array.isArray(aliases) && typeof aliases[0] === "string" ? aliases[0] : "";
    }
    return null;
}

/**
 * Puts `service` on the proxy network under `alias`, declaring the network as
 * external at the top level.
 *
 * A service with no `networks:` of its own sits on the stack's implicit
 * `default` network — and the moment it declares any, it *leaves* that network
 * unless `default` is listed too, taking its links to sibling services with
 * it. So a service that had none gets `default: {}` alongside the new entry.
 * One that already lists networks is left exactly as the author had it, plus
 * the proxy network; if it deliberately isn't on `default`, that stays true.
 */
export function attachToProxyNetwork(doc: Document, service: string, alias: string): void {
    if (getServiceField(doc, service, "network_mode") !== undefined) {
        throw new Error(`${service} uses network_mode and can't join a docker network — route to a published host port instead`);
    }
    const top = ensureMapPath(doc, ["networks"]);
    if (!isMap(top.get(PROXY_NETWORK, true))) {
        top.set(PROXY_NETWORK, doc.createNode({ external: true }));
    }

    const svc = ensureMapPath(doc, ["services", service]);
    const current = svc.get("networks", true);
    let networks: YAMLMap;
    if (isMap(current)) {
        networks = current;
    } else {
        // A list form (`- default`, `- backend`) becomes the map form, since
        // an alias only fits there; each name keeps its meaning as an empty entry.
        networks = new YAMLMap(doc.schema);
        const names = isSeq(current) ? current.items.map((i) => String(toJs(i))) : ["default"];
        for (const name of names) {
            networks.set(name, doc.createNode({}));
        }
        svc.set("networks", networks);
    }
    networks.set(PROXY_NETWORK, doc.createNode({ aliases: [alias] }));
}

/** Undo of `attachToProxyNetwork`: drops the service's proxy-network entry
 *  (and a `networks:` block that then says only `default`), and the top-level
 *  declaration once no service refers to it any more. */
export function detachFromProxyNetwork(doc: Document, service: string): void {
    const svc = doc.getIn(["services", service], true);
    if (isMap(svc)) {
        const networks = svc.get("networks", true);
        if (isMap(networks)) {
            networks.delete(PROXY_NETWORK);
            const rest = networks.items.map((i) => String(toJs(i.key)));
            if (rest.length === 0 || (rest.length === 1 && rest[0] === "default")) {
                svc.delete("networks");
            }
        } else if (isSeq(networks)) {
            const idx = networks.items.findIndex((i) => toJs(i) === PROXY_NETWORK);
            if (idx !== -1) {
                networks.delete(idx);
            }
        }
    }
    const stillUsed = listServiceNames(doc).some((name) => serviceProxyAlias(doc, name) !== null);
    if (!stillUsed) {
        doc.deleteIn(["networks", PROXY_NETWORK]);
        const top = doc.get("networks", true);
        if (isMap(top) && top.items.length === 0) {
            doc.delete("networks");
        }
    }
}

// ---- volumes ----------------------------------------------------------------------

export interface VolumeRow {
    kind: "short" | "long" | "raw";
    source: string;
    target: string;
    readOnly: boolean;
    /** Non-ro/rw short-form flags (e.g. "z", "cached") preserved verbatim. */
    extraFlags?: string;
    raw?: unknown;
}

export function looksLikeHostPath(source: string): boolean {
    return source.startsWith("/") || source.startsWith("./") || source.startsWith("../") || source.startsWith("~");
}

/** Drop a trailing slash, except from "/" itself. */
function trimTrailingSlash(dir: string): string {
    return dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
}

/**
 * Rewrite an absolute host path into one relative to the stack's own directory
 * (`/opt/sc-apps/blog/data` → `./data`) when it sits at or under it.
 *
 * Compose resolves a relative bind source against the directory holding the
 * compose file, so the relative form is what survives moving or copying a stack:
 * the absolute form keeps pointing at where the stack used to be, and does it
 * silently, since the old path usually still exists.
 *
 * Only paths inside the stack are rewritten. A `../` chain climbing out of it
 * would be relative in name only — it still depends on where the stack sits —
 * while being harder to read than the absolute path it replaced.
 *
 * The leading `./` is not cosmetic: compose reads a bare `data` as a *named
 * volume*, not a bind mount, so dropping it changes what the entry means.
 */
export function relativizeToStack(source: string, stackDir: string): string {
    const stack = trimTrailingSlash(stackDir);
    // "/" as a stack dir would make every path on the host "inside" it.
    if (!source.startsWith("/") || stack === "/" || !stack) {
        return source;
    }
    const path = trimTrailingSlash(source);
    if (path === stack) {
        return ".";
    }
    return path.startsWith(`${stack}/`) ? `.${path.slice(stack.length)}` : source;
}

/**
 * Inverse of {@link relativizeToStack}: the absolute host path a source resolves
 * to, for the pickers and anything else that has to browse it. Sources that
 * aren't stack-relative (absolute, `~`, a named volume) come back untouched.
 */
export function resolveAgainstStack(source: string, stackDir: string): string {
    if (source !== "." && !source.startsWith("./") && !source.startsWith("../")) {
        return source;
    }
    const segments = trimTrailingSlash(stackDir).split("/");
    for (const part of source.split("/")) {
        if (part === "" || part === ".") {
            continue;
        }
        if (part === "..") {
            // segments[0] is the empty string before the leading "/", so stopping
            // at length 1 is what keeps a long "../" chain from climbing past root.
            if (segments.length > 1) {
                segments.pop();
            }
            continue;
        }
        segments.push(part);
    }
    return segments.join("/") || "/";
}

export function parseVolumeEntry(entry: unknown): VolumeRow {
    if (typeof entry === "string") {
        const parts = entry.split(":");
        if (parts.length < 2 || parts.length > 3) {
            return { kind: "raw", source: "", target: "", readOnly: false, raw: entry };
        }
        const [source, target, mode] = parts;
        const flags = (mode ?? "").split(",").filter(Boolean);
        return {
            kind: "short",
            source,
            target,
            readOnly: flags.includes("ro"),
            extraFlags: flags.filter((f) => f !== "ro" && f !== "rw").join(",") || undefined,
        };
    }
    if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        if (o.type !== undefined && o.type !== "bind" && o.type !== "volume") {
            return { kind: "raw", source: "", target: "", readOnly: false, raw: o };
        }
        return {
            kind: "long",
            source: (o.source as string | undefined) ?? "",
            target: (o.target as string | undefined) ?? "",
            readOnly: o.read_only === true || o.read_only === "true",
        };
    }
    return { kind: "raw", source: "", target: "", readOnly: false, raw: entry };
}

export function serializeVolumeRow(row: VolumeRow): unknown {
    if (row.kind === "raw") {
        return row.raw;
    }
    if (row.kind === "long") {
        const o: Record<string, unknown> = {
            type: looksLikeHostPath(row.source) ? "bind" : "volume",
            source: row.source,
            target: row.target,
        };
        if (row.readOnly) {
            o.read_only = true;
        }
        return o;
    }
    const flags = [row.readOnly ? "ro" : "", row.extraFlags ?? ""].filter(Boolean).join(",");
    return flags ? `${row.source}:${row.target}:${flags}` : `${row.source}:${row.target}`;
}

// ---- devices ----------------------------------------------------------------------

export interface DeviceRow {
    kind: "short" | "long" | "raw";
    /** Host path, e.g. `/dev/serial/by-id/usb-…-if00`. */
    source: string;
    /** Path inside the container. Empty means "same as source" — compose's own
     *  default for a one-part short entry. */
    target: string;
    /** Cgroup permissions: r(ead) w(rite) m(knod). Empty means compose's default
     *  of `rwm`, which is what nearly every mapping wants. */
    permissions: string;
    /** Entry couldn't be decomposed (an unexpected long-form key, a non-string
     *  scalar) — shown read-only, edit via the YAML tab. */
    raw?: unknown;
}

export function parseDeviceEntry(entry: unknown): DeviceRow {
    if (typeof entry === "string") {
        const parts = entry.split(":");
        if (parts.length < 1 || parts.length > 3 || !parts[0]) {
            return { kind: "raw", source: "", target: "", permissions: "", raw: entry };
        }
        return { kind: "short", source: parts[0], target: parts[1] ?? "", permissions: parts[2] ?? "" };
    }
    if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        const extraKeys = Object.keys(o).some((k) => !["source", "target", "permissions"].includes(k));
        if (extraKeys || typeof o.source !== "string") {
            return { kind: "raw", source: "", target: "", permissions: "", raw: o };
        }
        return {
            kind: "long",
            source: o.source,
            target: (o.target as string | undefined) ?? "",
            permissions: (o.permissions as string | undefined) ?? "",
        };
    }
    return { kind: "raw", source: "", target: "", permissions: "", raw: entry };
}

export function serializeDeviceRow(row: DeviceRow): unknown {
    if (row.kind === "raw") {
        return row.raw;
    }
    if (row.kind === "long") {
        const o: Record<string, unknown> = { source: row.source };
        if (row.target) {
            o.target = row.target;
        }
        if (row.permissions) {
            o.permissions = row.permissions;
        }
        return o;
    }
    // Permissions are positional in short form, so they can't be written without
    // a target — fall back to repeating the source, which is what compose would
    // have defaulted the target to anyway.
    if (row.permissions) {
        return `${row.source}:${row.target || row.source}:${row.permissions}`;
    }
    return row.target ? `${row.source}:${row.target}` : row.source;
}

// ---- environment (list_or_dict) ----------------------------------------------------

export interface EnvRow {
    key: string;
    value: string;
}

export function parseEnvironment(entry: unknown): { rows: EnvRow[]; asObject: boolean } {
    if (Array.isArray(entry)) {
        return {
            asObject: false,
            rows: entry.map((s) => {
                const str = String(s);
                const i = str.indexOf("=");
                return i === -1 ? { key: str, value: "" } : { key: str.slice(0, i), value: str.slice(i + 1) };
            }),
        };
    }
    if (entry && typeof entry === "object") {
        return {
            asObject: true,
            rows: Object.entries(entry as Record<string, unknown>).map(([key, value]) => ({
                key,
                value: value == null ? "" : String(value),
            })),
        };
    }
    return { asObject: false, rows: [] };
}

export function serializeEnvironment(rows: EnvRow[], asObject: boolean): unknown {
    const filled = rows.filter((r) => r.key);
    if (asObject) {
        const o: Record<string, string> = {};
        for (const r of filled) {
            o[r.key] = r.value;
        }
        return o;
    }
    return filled.map((r) => `${r.key}=${r.value}`);
}
