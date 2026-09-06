import { expect, test } from "bun:test";
import { MULTIPART_META_FIELD, isBinaryPart, type BinaryPart, type MultipartMeta } from "@central/shared";
import { multipartBoundary, parseRpcMultipart } from "../../src/http/multipart";

// The parser that lets an upload cross the control plane without ever being held
// in it. Two properties matter beyond "it parses": it must never buffer a part
// (so a 4GB upload costs the same RSS as a 4KB one), and it must not trust a
// single number the sender declared about sizes.

const BOUNDARY = "----scTestBoundary9tX";

/** A multipart body in the shape the API client produces: JSON meta, then one
 *  part per declared binary field, in declaration order. */
function buildBody(meta: MultipartMeta, parts: Array<{ name: string; bytes: Uint8Array }>): Uint8Array {
    const enc = new TextEncoder();
    const pieces: Uint8Array[] = [];
    const push = (s: string) => pieces.push(enc.encode(s));

    push(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${MULTIPART_META_FIELD}"\r\n\r\n`);
    push(JSON.stringify(meta));
    for (const part of parts) {
        push(`\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.name}.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`);
        pieces.push(part.bytes);
    }
    push(`\r\n--${BOUNDARY}--\r\n`);

    const total = pieces.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of pieces) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

/** A request whose body arrives in `chunkSize` pieces — the knob that decides
 *  whether a delimiter lands inside one chunk or straddles several. */
function request(body: Uint8Array, chunkSize = body.length): Request {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (let i = 0; i < body.length; i += chunkSize) {
                controller.enqueue(body.subarray(i, i + chunkSize));
            }
            controller.close();
        },
    });
    return new Request("http://localhost/api/files/upload", {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${BOUNDARY}` },
        body: stream,
        // @ts-expect-error Node/Bun require this for a stream body
        duplex: "half",
    });
}

async function collect(part: BinaryPart): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of part.stream() as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.length;
    }
    return out;
}

const LIMITS = { maxBytes: 64 * 1024 * 1024 };

function payload(size: number, seed = 7): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(new ArrayBuffer(size));
    for (let i = 0; i < size; i++) {
        out[i] = (i * 31 + seed) & 0xff;
    }
    return out;
}

test("the handler argument is whole before any file bytes arrive", async () => {
    const content = payload(4096);
    const body = buildBody(
        { fields: { serverId: "srv-1", path: "/tmp/x.bin" }, binary: [{ name: "content", size: content.length, type: "application/octet-stream" }] },
        [{ name: "content", bytes: content }],
    );
    const { data } = await parseRpcMultipart(request(body), LIMITS);

    // Everything the handler reads off `data` looks like an ordinary payload...
    expect(data.serverId).toBe("srv-1");
    expect(data.path).toBe("/tmp/x.bin");
    // ...except the field that is bytes, which is a handle to them.
    expect(isBinaryPart(data.content)).toBe(true);
    expect((data.content as BinaryPart).size).toBe(content.length);
    expect((data.content as BinaryPart).type).toBe("application/octet-stream");
    expect(await collect(data.content as BinaryPart)).toEqual(content);
});

test("a delimiter split across arriving chunks is still found", async () => {
    // One byte at a time: every delimiter, header and terminator straddles the
    // buffer, which is the case a naive scan of each chunk in isolation misses.
    const content = payload(300);
    const body = buildBody(
        { fields: { path: "/tmp/x" }, binary: [{ name: "content", size: content.length, type: "" }] },
        [{ name: "content", bytes: content }],
    );
    const { data } = await parseRpcMultipart(request(body, 1), LIMITS);
    expect(await collect(data.content as BinaryPart)).toEqual(content);
});

test("content that contains the boundary text is not mistaken for one", async () => {
    // The delimiter is CRLF + "--" + boundary; the bare boundary string inside a
    // payload must pass through untouched.
    const enc = new TextEncoder();
    const content = enc.encode(`before--${BOUNDARY}after`);
    const body = buildBody(
        { fields: {}, binary: [{ name: "content", size: content.length, type: "" }] },
        [{ name: "content", bytes: content }],
    );
    const { data } = await parseRpcMultipart(request(body, 3), LIMITS);
    expect(await collect(data.content as BinaryPart)).toEqual(content);
});

test("a part is streamed, never buffered", async () => {
    // 32MB delivered in 64KB chunks. If any layer accumulated the part, the peak
    // would track the part size; it must track the chunk size instead.
    const size = 32 * 1024 * 1024;
    const content = payload(size);
    const body = buildBody(
        { fields: {}, binary: [{ name: "content", size, type: "" }] },
        [{ name: "content", bytes: content }],
    );

    const { data } = await parseRpcMultipart(request(body, 64 * 1024), LIMITS);
    let largest = 0;
    let total = 0;
    for await (const chunk of (data.content as BinaryPart).stream() as unknown as AsyncIterable<Uint8Array>) {
        largest = Math.max(largest, chunk.length);
        total += chunk.length;
    }
    expect(total).toBe(size);
    // Each chunk stays on the order of a source chunk — nothing grows with the part.
    expect(largest).toBeLessThan(1024 * 1024);
});

test("more bytes than declared is refused mid-stream, not after", async () => {
    const content = payload(8192);
    const body = buildBody(
        { fields: {}, binary: [{ name: "content", size: 1024, type: "" }] },
        [{ name: "content", bytes: content }],
    );
    const { data } = await parseRpcMultipart(request(body, 512), LIMITS);
    await expect(collect(data.content as BinaryPart)).rejects.toThrow(/exceeds 1024 bytes/);
});

test("fewer bytes than declared fails rather than writing a short file", async () => {
    const content = payload(1000);
    const body = buildBody(
        { fields: {}, binary: [{ name: "content", size: 4096, type: "" }] },
        [{ name: "content", bytes: content }],
    );
    const { data } = await parseRpcMultipart(request(body), LIMITS);
    await expect(collect(data.content as BinaryPart)).rejects.toThrow(/truncated/);
});

test("a declared total over the cap is refused before the body is read", async () => {
    const content = payload(64);
    const body = buildBody(
        { fields: {}, binary: [{ name: "content", size: 900 * 1024 * 1024, type: "" }] },
        [{ name: "content", bytes: content }],
    );
    await expect(parseRpcMultipart(request(body), { maxBytes: 1024 * 1024 })).rejects.toThrow(/Upload too large/);
});

test("a lying declaration doesn't get past the real byte count", async () => {
    // Declares 1KB, sends 4MB: the cap has to hold against the bytes, not the claim.
    const content = payload(4 * 1024 * 1024);
    const body = buildBody(
        { fields: {}, binary: [{ name: "content", size: 1024, type: "" }] },
        [{ name: "content", bytes: content }],
    );
    const { data } = await parseRpcMultipart(request(body, 64 * 1024), { maxBytes: 2 * 1024 * 1024 });
    await expect(collect(data.content as BinaryPart)).rejects.toThrow(/exceeds/);
});

test("a body that doesn't lead with the meta part is refused", async () => {
    const enc = new TextEncoder();
    const raw = enc.encode(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="content"\r\n\r\nhi\r\n--${BOUNDARY}--\r\n`,
    );
    await expect(parseRpcMultipart(request(raw), LIMITS)).rejects.toThrow(/expected "__meta" first/);
});

test("a binary field can only be read once, and only in order", async () => {
    const a = payload(64, 1);
    const b = payload(64, 2);
    const body = buildBody(
        { fields: {}, binary: [{ name: "a", size: a.length, type: "" }, { name: "b", size: b.length, type: "" }] },
        [{ name: "a", bytes: a }, { name: "b", bytes: b }],
    );
    const { data } = await parseRpcMultipart(request(body), LIMITS);

    // The wire is at part "a"; "b" cannot be reached without reading through it.
    expect(() => (data.b as BinaryPart).stream()).toThrow(/declaration order/);
    expect(await collect(data.a as BinaryPart)).toEqual(a);
    expect(() => (data.a as BinaryPart).stream()).toThrow(/already been read/);
    expect(await collect(data.b as BinaryPart)).toEqual(b);
});

test("drain releases a body the handler never read", async () => {
    const content = payload(1024 * 1024);
    const body = buildBody(
        { fields: {}, binary: [{ name: "content", size: content.length, type: "" }] },
        [{ name: "content", bytes: content }],
    );
    const parsed = await parseRpcMultipart(request(body), LIMITS);
    // A handler that threw before touching `content`: draining must still settle.
    await parsed.drain();
    await parsed.drain();
});

test("boundary is read from either quoted or bare content types", () => {
    expect(multipartBoundary("multipart/form-data; boundary=abc123")).toBe("abc123");
    expect(multipartBoundary(`multipart/form-data; boundary="a b c"`)).toBe("a b c");
    expect(multipartBoundary("multipart/form-data; charset=utf-8; boundary=xyz")).toBe("xyz");
    expect(multipartBoundary("application/json")).toBeNull();
    expect(multipartBoundary("multipart/form-data")).toBeNull();
    expect(multipartBoundary(null)).toBeNull();
});

test("what a browser's FormData produces parses too", async () => {
    // The hand-built bodies above pin the framing; this pins the fact that the
    // framing is the one the client actually emits.
    const content = payload(5000);
    const form = new FormData();
    form.set(MULTIPART_META_FIELD, JSON.stringify({
        fields: { serverId: "srv-1", path: "/tmp/y.bin" },
        binary: [{ name: "content", size: content.length, type: "application/octet-stream" }],
    } satisfies MultipartMeta));
    form.set("content", new Blob([content], { type: "application/octet-stream" }), "y.bin");

    const req = new Request("http://localhost/api/files/upload", { method: "POST", body: form });
    const { data } = await parseRpcMultipart(req, LIMITS);
    expect(data.serverId).toBe("srv-1");
    expect(await collect(data.content as BinaryPart)).toEqual(content);
});
