import { Document, YAMLMap, YAMLSeq, isMap, isSeq, parseDocument } from "yaml";

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
 * needs since v1 Apps start from exactly that empty scaffold.
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
