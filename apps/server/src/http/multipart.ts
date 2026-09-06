import type { BinaryPart, MultipartMeta } from "@central/shared";
import { MULTIPART_META_FIELD } from "@central/shared";

// ---- Streaming multipart, for RPC calls that carry bytes -------------------------
//
// A `multipart/form-data` reader that never holds more than one chunk of a part.
//
// Bun's own `req.formData()` is the obvious thing to reach for and the one thing
// that must not be used here: it buffers every part into memory before it
// returns, which is precisely the cost this whole path exists to avoid (measured
// on a 200MB part: ~320MB of extra RSS over reading `req.body` directly). So the
// framing is parsed by hand, straight off the request stream.
//
// The shape is fixed by `MultipartMeta`, not discovered: the first part is JSON
// declaring every field of the operation payload plus the binary fields that
// follow it, so the dispatcher can build a complete handler argument before any
// file data has arrived. Above this module nothing knows a request was framed
// this way — a handler receives an object whose binary fields happen to be
// streams (see `BinaryPart`).

const encoder = new TextEncoder();

function bytes(s: string): Uint8Array {
    return encoder.encode(s);
}

const CRLF = bytes("\r\n");
const CRLF_CRLF = bytes("\r\n\r\n");
const DASH_DASH = bytes("--");

/** A preamble before the first boundary is legal but nothing we emit produces
 *  one; a large one means we're not reading what we think we are. */
const MAX_PREAMBLE_BYTES = 8 * 1024;
/** One part's header block. Generous next to the two headers we expect. */
const MAX_PART_HEADER_BYTES = 16 * 1024;
/** The JSON part. Every non-binary field of an operation payload fits far
 *  inside this; the cap is here so a malformed body can't be read forever. */
const MAX_META_BYTES = 1024 * 1024;

function indexOfSub(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
    const last = haystack.length - needle.length;
    outer: for (let i = Math.max(0, from); i <= last; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) {
                continue outer;
            }
        }
        return i;
    }
    return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length === 0) {
        return b;
    }
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/**
 * A pull-based cursor over a byte stream: enough buffering to find a delimiter,
 * and no more. Everything the parser needs is expressed as "give me the bytes up
 * to this needle" — either collected (headers, which are small and bounded) or
 * streamed (part bodies, which are neither).
 */
class ByteCursor {
    private buf: Uint8Array = new Uint8Array(0);
    private ended = false;
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

    constructor(stream: ReadableStream<Uint8Array>) {
        this.reader = stream.getReader();
    }

    /** Pull one more chunk into the buffer. False once the stream is spent. */
    private async fill(): Promise<boolean> {
        if (this.ended) {
            return false;
        }
        const { value, done } = await this.reader.read();
        if (done || !value) {
            this.ended = true;
            return false;
        }
        this.buf = concat(this.buf, value);
        return true;
    }

    private take(n: number): Uint8Array {
        const out = this.buf.subarray(0, n);
        this.buf = this.buf.subarray(n);
        return out;
    }

    /** Exactly `n` bytes, or a throw if the stream ends first. */
    async readExact(n: number): Promise<Uint8Array> {
        while (this.buf.length < n) {
            if (!await this.fill()) {
                throw new Error("Malformed multipart body: truncated");
            }
        }
        return this.take(n);
    }

    /** Everything up to `needle`, consuming the needle. Throws past `limit`, so
     *  a body that never contains it can't be buffered without bound. */
    async readUntil(needle: Uint8Array, limit: number): Promise<Uint8Array> {
        let searched = 0;
        for (;;) {
            const at = indexOfSub(this.buf, needle, searched);
            if (at !== -1) {
                const out = this.take(at);
                this.take(needle.length);
                return out;
            }
            // A needle straddling two chunks must still be found: resume the
            // next scan far enough back to cover a partial match at the tail.
            searched = Math.max(0, this.buf.length - needle.length + 1);
            if (this.buf.length > limit) {
                throw new Error("Malformed multipart body: oversized section");
            }
            if (!await this.fill()) {
                throw new Error("Malformed multipart body: truncated");
            }
        }
    }

    /**
     * Everything up to `needle`, a chunk at a time, consuming the needle. The
     * streaming counterpart of {@link readUntil} — the buffer never grows past
     * one source chunk plus the few bytes a partial needle could occupy.
     */
    async *chunksUntil(needle: Uint8Array): AsyncGenerator<Uint8Array> {
        for (;;) {
            const at = indexOfSub(this.buf, needle);
            if (at !== -1) {
                if (at > 0) {
                    yield this.take(at);
                }
                this.take(needle.length);
                return;
            }
            // Hold back the tail that could be the start of the needle; emit the
            // rest. Everything emitted is known not to contain it.
            const safe = this.buf.length - (needle.length - 1);
            if (safe > 0) {
                yield this.take(safe);
            }
            if (!await this.fill()) {
                throw new Error("Malformed multipart body: truncated part");
            }
        }
    }

    async cancel(): Promise<void> {
        await this.reader.cancel().catch(() => { });
    }
}

/** The boundary parameter of a `multipart/form-data` content type, or null when
 *  the header isn't one. Quoted and bare forms both occur in the wild. */
export function multipartBoundary(contentType: string | null): string | null {
    if (!contentType || !contentType.toLowerCase().startsWith("multipart/form-data")) {
        return null;
    }
    const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
    const boundary = match?.[1] ?? match?.[2];
    return boundary ? boundary : null;
}

/** The `name` of a part, off its `Content-Disposition` header. */
function partName(headerBlock: string): string | null {
    for (const line of headerBlock.split("\r\n")) {
        if (!/^content-disposition\s*:/i.test(line)) {
            continue;
        }
        const match = /;\s*name=(?:"([^"]*)"|([^;\s]+))/i.exec(line);
        return match?.[1] ?? match?.[2] ?? null;
    }
    return null;
}

/**
 * One parsed multipart RPC body: the handler's argument, and the obligation that
 * comes with it.
 */
export interface RpcMultipart {
    /** The operation payload — JSON fields verbatim, binary fields as handles. */
    data: Record<string, unknown>;
    /**
     * Consume whatever the handler didn't. A `BinaryPart` is single-use and must
     * be read in declaration order; a handler that ignores one (or fails before
     * reading it) leaves bytes on the socket, and answering while they're still
     * arriving wedges the connection. The dispatcher calls this unconditionally.
     */
    drain(): Promise<void>;
}

/**
 * Read a multipart RPC body far enough to build the handler's argument — that
 * is, through the JSON meta part and no further. The binary fields come back as
 * `BinaryPart` handles over parts still in flight, so this returns while the
 * file is still on the wire, which is the entire point.
 *
 * `maxBytes` bounds the total of the binary parts. It's enforced against the
 * bytes actually seen, not the sizes the sender declared: the declaration is
 * used to fail fast and to size a progress bar, and is never trusted.
 */
export async function parseRpcMultipart(req: Request, opts: { maxBytes: number }): Promise<RpcMultipart> {
    const boundary = multipartBoundary(req.headers.get("content-type"));
    if (!boundary) {
        throw new Error("Malformed multipart body: no boundary");
    }
    if (!req.body) {
        throw new Error("Malformed multipart body: empty");
    }

    const cursor = new ByteCursor(req.body);
    const dashBoundary = concat(DASH_DASH, bytes(boundary));
    // Between parts the delimiter is preceded by the CRLF that ends the previous
    // part's body — that CRLF belongs to the delimiter, not to the payload.
    const bodyDelimiter = concat(CRLF, dashBoundary);

    // Skip anything before the opening delimiter (there shouldn't be any).
    await cursor.readUntil(dashBoundary, MAX_PREAMBLE_BYTES);

    /** Read the two bytes after a delimiter: CRLF for another part, `--` for the
     *  terminator. Returns the part's field name, or null at the end of body. */
    const openPart = async (): Promise<string | null> => {
        const marker = await cursor.readExact(2);
        if (marker[0] === DASH_DASH[0] && marker[1] === DASH_DASH[1]) {
            return null;
        }
        if (marker[0] !== CRLF[0] || marker[1] !== CRLF[1]) {
            throw new Error("Malformed multipart body: bad delimiter");
        }
        const header = await cursor.readUntil(CRLF_CRLF, MAX_PART_HEADER_BYTES);
        const name = partName(new TextDecoder().decode(header));
        if (name === null) {
            throw new Error("Malformed multipart body: part has no name");
        }
        return name;
    };

    const metaName = await openPart();
    if (metaName !== MULTIPART_META_FIELD) {
        throw new Error(`Malformed multipart body: expected "${MULTIPART_META_FIELD}" first, got "${metaName ?? "end of body"}"`);
    }
    const metaRaw = await cursor.readUntil(bodyDelimiter, MAX_META_BYTES);

    let meta: MultipartMeta;
    try {
        meta = JSON.parse(new TextDecoder().decode(metaRaw)) as MultipartMeta;
    } catch {
        throw new Error("Malformed multipart body: meta is not JSON");
    }
    const declared = Array.isArray(meta?.binary) ? meta.binary : [];
    const fields = (meta?.fields ?? {}) as Record<string, unknown>;
    if (typeof fields !== "object" || fields === null) {
        throw new Error("Malformed multipart body: meta.fields is not an object");
    }

    const declaredTotal = declared.reduce((sum, d) => sum + (Number(d.size) || 0), 0);
    if (declaredTotal > opts.maxBytes) {
        throw new Error(`Upload too large: ${declaredTotal} bytes (max ${opts.maxBytes})`);
    }

    // Parts arrive in the order `meta.binary` declares, and a stream can't be
    // rewound, so consumption has to follow that order too. `cursor` tracks how
    // far through the declaration the wire has got.
    let atPart = 0;
    let seenTotal = 0;
    let finished = declared.length === 0;

    /** Read part `index`'s body through, handing chunks to `onChunk`. */
    const consumePart = async function* (index: number): AsyncGenerator<Uint8Array> {
        const spec = declared[index];
        const name = await openPart();
        if (name !== spec.name) {
            throw new Error(`Malformed multipart body: expected part "${spec.name}", got "${name ?? "end of body"}"`);
        }
        let seen = 0;
        for await (const chunk of cursor.chunksUntil(bodyDelimiter)) {
            seen += chunk.length;
            seenTotal += chunk.length;
            // Checked per chunk, not at the end: the point of a cap is to stop
            // reading, not to report afterwards that too much was read.
            if (seen > spec.size) {
                throw new Error(`Upload larger than declared: part "${spec.name}" exceeds ${spec.size} bytes`);
            }
            if (seenTotal > opts.maxBytes) {
                throw new Error(`Upload too large: exceeds ${opts.maxBytes} bytes`);
            }
            yield chunk;
        }
        if (seen !== spec.size) {
            throw new Error(`Upload truncated: part "${spec.name}" was ${seen} bytes, declared ${spec.size}`);
        }
        atPart = index + 1;
        if (atPart === declared.length) {
            finished = true;
        }
    };

    const data: Record<string, unknown> = { ...fields };
    const consumed = new Set<number>();

    declared.forEach((spec, index) => {
        const part: BinaryPart = {
            size: Number(spec.size) || 0,
            type: typeof spec.type === "string" ? spec.type : "",
            stream(): ReadableStream<Uint8Array> {
                if (consumed.has(index)) {
                    throw new Error(`Binary field "${spec.name}" has already been read`);
                }
                if (index !== atPart) {
                    throw new Error(`Binary field "${spec.name}" must be read in declaration order`);
                }
                consumed.add(index);
                const chunks = consumePart(index);
                return new ReadableStream<Uint8Array>({
                    async pull(controller) {
                        try {
                            const { value, done } = await chunks.next();
                            if (done) {
                                controller.close();
                            } else {
                                controller.enqueue(value);
                            }
                        } catch (err) {
                            controller.error(err);
                        }
                    },
                    async cancel() {
                        await chunks.return(undefined);
                    },
                });
            },
        };
        data[spec.name] = part;
    });

    return {
        data,
        async drain(): Promise<void> {
            if (finished) {
                return;
            }
            // Nothing here needs the bytes, only the socket back. Cancelling the
            // reader beats reading to the terminator: a handler that bailed on a
            // 200MB part shouldn't be followed by the server dutifully reading
            // the other 199.
            await cursor.cancel();
        },
    };
}
