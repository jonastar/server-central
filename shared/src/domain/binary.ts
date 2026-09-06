// ---- Binary payloads ---------------------------------------------------------
//
// A few operations carry bytes rather than values — a file upload today, a file
// download later. Those bytes must never become a JSON string: base64 inside a
// JSON body costs the whole file, in memory, at every hop between the browser
// and the host's disk. So they travel beside the JSON instead, and the field
// that would have held them holds a handle to them.

/**
 * A binary field in an operation payload.
 *
 * Structural on purpose. The browser's `File`/`Blob` satisfies this as-is, and
 * the control plane's multipart parser synthesizes an object of the same shape
 * backed by a part still arriving on the socket. One type therefore describes
 * both ends of the wire with no conditional type and no per-side augmentation:
 * an operation that carries bytes reads the same in the client that calls it and
 * in the handler that serves it.
 *
 * It is a *handle*, not the bytes. `stream()` is the whole point — it's what
 * lets an upload cost one chunk of memory instead of one file, at every hop.
 * Nothing above the protocol layer should ever collect it back into a buffer.
 *
 * Server-side instances are single-use: the bytes arrive once, in order, and
 * cannot be rewound. `Blob` happens to be re-readable, but code that relies on
 * that will break the moment it runs against a real request, so treat every
 * `BinaryPart` as consume-exactly-once.
 */
export interface BinaryPart {
    /** Total bytes, known before any of them are read. */
    readonly size: number;
    /** MIME type, or `""` when the sender didn't declare one. */
    readonly type: string;
    /** The bytes. Call once; a second call throws server-side. */
    stream(): ReadableStream<Uint8Array>;
}

/**
 * Whether a value is a binary field — the check the API client uses to decide
 * that a call needs multipart framing, and the server uses to recognize what its
 * own parser produced.
 *
 * Structural rather than `instanceof Blob`: this runs in the browser, in the
 * control plane and in the agent, and only one of those three is guaranteed to
 * have the same `Blob` constructor in scope as the value being tested.
 */
export function isBinaryPart(value: unknown): value is BinaryPart {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const candidate = value as Partial<BinaryPart>;
    return typeof candidate.size === "number" && typeof candidate.stream === "function";
}

/**
 * The wire framing for a multipart RPC call, as the first part of the body.
 *
 * The binary fields are *declared* here rather than discovered by walking the
 * parts, so the server can build the complete handler argument — every JSON
 * field, plus a handle for every binary one — from the first part alone, before
 * a single byte of file data has arrived. That's what keeps multipart invisible
 * above the protocol layer: the handler is called with a whole object, and the
 * bytes flow later, through it.
 *
 * `size` is the sender's claim and is used only to size progress and to reject
 * an oversized upload early; the real count is enforced as the bytes arrive.
 */
export interface MultipartMeta {
    /** Every non-binary field of the operation payload. */
    fields: Record<string, unknown>;
    /** The binary fields, in the order their parts follow this one. */
    binary: Array<{ name: string; size: number; type: string }>;
}

/** Field name of the JSON part that opens a multipart RPC body. Leading `__` so
 *  it can't collide with an operation's own field of the same name. */
export const MULTIPART_META_FIELD = "__meta";

/** Content type marking an RPC body as multipart-framed. The boundary parameter
 *  is appended by whoever builds the body (the browser, for `FormData`). */
export const MULTIPART_CONTENT_TYPE = "multipart/form-data";
