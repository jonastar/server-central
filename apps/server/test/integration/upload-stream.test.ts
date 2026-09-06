import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { BinaryPart, ControlMessage, MultipartMeta, UserInfo } from "@central/shared";
import { AGENT_CAPABILITIES, MULTIPART_META_FIELD, UPLOAD_CHUNK_BYTES, UPLOAD_REQUEST_BYTES } from "@central/shared";
import { Agent, type AgentTransport } from "../../src/agent/agent";
import { HostAgent } from "../../src/host-agent";
import { handleRpc, type ApiTable } from "../../src/http/rpc";

// End to end for the upload path, from an HTTP request body to bytes on disk.
//
// The property under test throughout is that no hop ever holds the file: the
// browser streams a `File` part, the control plane streams that part into
// UPLOAD_CHUNK_BYTES slices, and the agent appends each to a temp file it renames
// into place at the end. The assertions that count chunks are what keep that
// honest — a regression that buffers somewhere still produces the right file, and
// would pass every test that only compared bytes.

const dirs: string[] = [];

afterEach(async () => {
    for (const dir of dirs.splice(0)) {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

async function tempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-upload-test-"));
    dirs.push(dir);
    return dir;
}

/** A control plane talking to an in-process agent, as `createEmbeddedAgent`
 *  wires them — the real HostAgent and the real Agent, only the socket faked.
 *  `sent` records the control messages so a test can see the chunking. */
function wireAgent(capabilities: readonly string[] = AGENT_CAPABILITIES) {
    const sent: ControlMessage[] = [];
    const host: HostAgent = new HostAgent(
        (msg) => { sent.push(msg); void agent.onMessage(msg); },
        "machine-1",
        "test-host",
        null,
        () => { },
        "embedded",
        null,
        capabilities,
        {},
    );
    const transport: AgentTransport = { send: (nodeMsg) => host.receive(nodeMsg) };
    const agent = new Agent(transport, true);
    return { host, agent, sent };
}

function payload(size: number, seed = 3): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(new ArrayBuffer(size));
    for (let i = 0; i < size; i++) {
        out[i] = (i * 17 + seed) & 0xff;
    }
    return out;
}

/** A BinaryPart over bytes already in hand, delivered in `chunkSize` pieces —
 *  stands in for a part arriving off a socket. */
function partOf(bytes: Uint8Array, chunkSize = 64 * 1024): BinaryPart {
    return {
        size: bytes.length,
        type: "application/octet-stream",
        stream: () => new ReadableStream<Uint8Array>({
            start(controller) {
                for (let i = 0; i < bytes.length; i += chunkSize) {
                    controller.enqueue(bytes.subarray(i, i + chunkSize));
                }
                controller.close();
            },
        }),
    };
}

/** A BinaryPart that dies partway through, the way a browser hanging up mid-upload
 *  looks from the control plane's side. */
function failingPart(bytes: Uint8Array, failAfter: number): BinaryPart {
    return {
        size: bytes.length,
        type: "",
        stream: () => {
            let at = 0;
            return new ReadableStream<Uint8Array>({
                pull(controller) {
                    if (at >= failAfter) {
                        controller.error(new Error("connection lost"));
                        return;
                    }
                    const end = Math.min(at + 64 * 1024, failAfter);
                    controller.enqueue(bytes.subarray(at, end));
                    at = end;
                },
            });
        },
    };
}

/** One request carrying a whole file — every file under UPLOAD_REQUEST_BYTES. */
function oneShot() {
    return { uploadId: crypto.randomUUID(), offset: 0, final: true };
}

/** Temp files the agent leaves behind are the failure mode that matters most on
 *  an error path, since nothing else would ever clean them up. */
async function tempLeftovers(dir: string): Promise<string[]> {
    return (await fs.readdir(dir)).filter((name) => name.includes(".sc-tmp-"));
}

test("a multi-chunk upload lands byte-for-byte", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "big.bin");
    const { host, sent } = wireAgent();
    const content = payload(UPLOAD_CHUNK_BYTES * 2 + 1234);

    const result = await host.uploadFile(target, partOf(content), oneShot());

    expect(result.bytesWritten).toBe(content.length);
    expect(new Uint8Array(await fs.readFile(target))).toEqual(content);

    // Three chunks (two full, one remainder), and the last one is the one that
    // publishes the file. If this ever becomes 1, something started buffering.
    const chunks = sent.filter((m) => m.type === "uploadChunkRequest");
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.offset)).toEqual([0, UPLOAD_CHUNK_BYTES, UPLOAD_CHUNK_BYTES * 2]);
    expect(chunks.filter((c) => c.final)).toHaveLength(1);
    expect(chunks.at(-1)?.final).toBe(true);
    expect(sent.some((m) => m.type === "uploadFileRequest")).toBe(false);
});

test("no chunk carries more than the chunk size, whatever the file size", async () => {
    const dir = await tempDir();
    const { host, sent } = wireAgent();
    await host.uploadFile(path.join(dir, "x.bin"), partOf(payload(UPLOAD_CHUNK_BYTES * 3), 7919), oneShot());

    for (const msg of sent) {
        if (msg.type === "uploadChunkRequest") {
            // base64 is ~4/3 of the raw slice; the raw slice is what's bounded.
            expect(Buffer.from(msg.contentBase64, "base64").length).toBeLessThanOrEqual(UPLOAD_CHUNK_BYTES);
        }
    }
});

test("a file smaller than one chunk is a single final chunk", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "small.txt");
    const { host, sent } = wireAgent();
    const content = new TextEncoder().encode("hello world");

    await host.uploadFile(target, partOf(content), oneShot());

    expect(await fs.readFile(target, "utf8")).toBe("hello world");
    expect(sent.filter((m) => m.type === "uploadChunkRequest")).toHaveLength(1);
});

test("an empty file still arrives", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "empty.bin");
    const { host } = wireAgent();

    const result = await host.uploadFile(target, partOf(new Uint8Array(0)), oneShot());

    expect(result.bytesWritten).toBe(0);
    expect((await fs.stat(target)).size).toBe(0);
});

test("a failed upload leaves the previous file untouched", async () => {
    // The property the pre-chunking path didn't have: it wrote straight to the
    // destination, so a transfer that died halfway truncated the real file.
    const dir = await tempDir();
    const target = path.join(dir, "precious.bin");
    await fs.writeFile(target, "the original contents");

    const { host } = wireAgent();
    const content = payload(UPLOAD_CHUNK_BYTES * 3);

    await expect(host.uploadFile(target, failingPart(content, UPLOAD_CHUNK_BYTES + 100), oneShot())).rejects.toThrow(/connection lost/);

    expect(await fs.readFile(target, "utf8")).toBe("the original contents");
    expect(await tempLeftovers(dir)).toEqual([]);
});

test("aborting removes the temp file rather than leaving it for the idle timer", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "gone.bin");
    const { host, sent } = wireAgent();

    await expect(host.uploadFile(target, failingPart(payload(UPLOAD_CHUNK_BYTES * 2), UPLOAD_CHUNK_BYTES + 1), oneShot())).rejects.toThrow();

    // The control plane tells the agent to drop it, and the agent has.
    expect(sent.some((m) => m.type === "uploadAbort")).toBe(true);
    expect(await tempLeftovers(dir)).toEqual([]);
    await expect(fs.stat(target)).rejects.toThrow();
});

test("a chunk claiming the wrong offset is refused instead of written there", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "ordered.bin");
    const { agent, host } = wireAgent();

    // Drive the agent directly. The offset comes from the browser and crosses
    // request boundaries, so the host is the only place that knows what actually
    // landed — which is exactly why it has to be the one that checks.
    await agent.onMessage({ type: "uploadChunkRequest", requestId: "r0", uploadId: "u1", path: target, offset: 0, contentBase64: Buffer.from("aaa").toString("base64"), final: false });
    await agent.onMessage({ type: "uploadChunkRequest", requestId: "r2", uploadId: "u1", path: target, offset: 999, contentBase64: Buffer.from("ccc").toString("base64"), final: true });

    // The bad offset fails the upload and takes the temp file with it, so no
    // partial file is ever published under the target name.
    await expect(fs.stat(target)).rejects.toThrow();
    expect(await tempLeftovers(dir)).toEqual([]);
    void host;
});

test("a file spanning several requests is appended into one file", async () => {
    // The property that removed the size limit: no single call carries the file,
    // so nothing anywhere has to be able to hold it.
    const dir = await tempDir();
    const target = path.join(dir, "spanning.bin");
    const { host, sent } = wireAgent();

    const slices = [payload(UPLOAD_CHUNK_BYTES + 11, 1), payload(UPLOAD_CHUNK_BYTES * 2, 2), payload(500, 3)];
    const uploadId = crypto.randomUUID();
    let offset = 0;
    let last = { bytesWritten: 0 };

    for (const [index, slice] of slices.entries()) {
        last = await host.uploadFile(target, partOf(slice), {
            uploadId, offset, final: index === slices.length - 1,
        });
        offset += slice.length;

        // Only the last request publishes: until then there's a temp file and no
        // target, so an interrupted upload never leaves a half file behind.
        if (index < slices.length - 1) {
            await expect(fs.stat(target)).rejects.toThrow();
            expect(await tempLeftovers(dir)).toHaveLength(1);
        }
    }

    const expected = new Uint8Array(offset);
    let at = 0;
    for (const slice of slices) {
        expected.set(slice, at);
        at += slice.length;
    }
    expect(new Uint8Array(await fs.readFile(target))).toEqual(expected);
    expect(last.bytesWritten).toBe(offset);
    expect(await tempLeftovers(dir)).toEqual([]);

    // Each request placed its chunks at absolute positions, continuing where the
    // previous one stopped rather than restarting at zero.
    const offsets = sent.filter((m) => m.type === "uploadChunkRequest").map((m) => m.offset);
    expect(offsets[0]).toBe(0);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(new Set(offsets).size).toBe(offsets.length);
});

test("a request that arrives at the wrong position fails the upload", async () => {
    // A retry or a dropped request would otherwise splice bytes into the middle
    // of a file and report success.
    const dir = await tempDir();
    const target = path.join(dir, "gapped.bin");
    const { host } = wireAgent();
    const uploadId = crypto.randomUUID();

    await host.uploadFile(target, partOf(payload(1000)), { uploadId, offset: 0, final: false });
    await expect(host.uploadFile(target, partOf(payload(1000)), { uploadId, offset: 5000, final: true }))
        .rejects.toThrow(/expected offset 1000, got 5000/);

    await expect(fs.stat(target)).rejects.toThrow();
    expect(await tempLeftovers(dir)).toEqual([]);
});

test("an upload can be any size, because no call is", async () => {
    // 256MB — past the cap that used to exist — in 32MB requests, with nothing
    // holding more than one chunk at any point.
    const dir = await tempDir();
    const target = path.join(dir, "huge.bin");
    const { host } = wireAgent();

    const slice = payload(UPLOAD_REQUEST_BYTES);
    const requests = 8;
    const uploadId = crypto.randomUUID();
    let result = { bytesWritten: 0 };
    for (let i = 0; i < requests; i++) {
        result = await host.uploadFile(target, partOf(slice), {
            uploadId, offset: i * UPLOAD_REQUEST_BYTES, final: i === requests - 1,
        });
    }

    expect(result.bytesWritten).toBe(UPLOAD_REQUEST_BYTES * requests);
    expect((await fs.stat(target)).size).toBe(UPLOAD_REQUEST_BYTES * requests);
}, 60_000);

test("an agent too old for multi-request uploads says so instead of truncating", async () => {
    // Such an agent writes a whole file per message, so feeding it slices would
    // leave only the last one on disk — a silent wrong answer.
    const dir = await tempDir();
    const target = path.join(dir, "legacy-big.bin");
    const { host } = wireAgent(AGENT_CAPABILITIES.filter((c) => c !== "uploadChunk"));

    await expect(host.uploadFile(target, partOf(payload(1000)), { uploadId: "u1", offset: 0, final: false }))
        .rejects.toThrow(/update the agent/);
    await expect(fs.stat(target)).rejects.toThrow();
});

test("an agent without the capability still gets its file", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "legacy.bin");
    const withoutChunking = AGENT_CAPABILITIES.filter((c) => c !== "uploadChunk");
    const { host, sent } = wireAgent(withoutChunking);
    const content = payload(200_000);

    const result = await host.uploadFile(target, partOf(content), oneShot());

    expect(result.bytesWritten).toBe(content.length);
    expect(new Uint8Array(await fs.readFile(target))).toEqual(content);
    // The old whole-file message, because that's all this agent understands.
    expect(sent.filter((m) => m.type === "uploadFileRequest")).toHaveLength(1);
    expect(sent.some((m) => m.type === "uploadChunkRequest")).toBe(false);
});

// ---- Through the front door ------------------------------------------------------

const OWNER: UserInfo = {
    id: "u1", username: "owner", isOwner: true, roleIds: [], permissions: ["*"], createdAt: 0,
} as unknown as UserInfo;

function rpcDeps(table: ApiTable) {
    return {
        table,
        auth: { authenticate: async () => OWNER } as unknown as Parameters<typeof handleRpc>[3]["auth"],
        originAllowed: () => true,
        clientIp: () => null,
    };
}

function multipartRequest(fields: Record<string, unknown>, name: string, bytes: Uint8Array<ArrayBuffer>): Request {
    const form = new FormData();
    form.set(MULTIPART_META_FIELD, JSON.stringify({
        fields,
        binary: [{ name, size: bytes.length, type: "application/octet-stream" }],
    } satisfies MultipartMeta));
    form.set(name, new Blob([bytes], { type: "application/octet-stream" }), "upload.bin");
    return new Request("http://localhost/api/files/upload", { method: "POST", body: form });
}

test("a multipart request reaches the handler as an ordinary payload", async () => {
    const dir = await tempDir();
    const target = path.join(dir, "viahttp.bin");
    const { host, sent } = wireAgent();
    const content = payload(UPLOAD_CHUNK_BYTES + 5000);

    // The handler is written against the operation type and knows nothing about
    // multipart — it reads `data.path` and hands `data.content` onward.
    const table: ApiTable = new Map([[
        "files/upload",
        async (data: unknown) => {
            const d = data as { path: string; content: BinaryPart; uploadId: string; offset: number; final: boolean };
            return host.uploadFile(d.path, d.content, { uploadId: d.uploadId, offset: d.offset, final: d.final });
        },
    ]]);

    const req = multipartRequest({ serverId: "machine-1", path: target, ...oneShot() }, "content", content);
    const res = await handleRpc(req, new URL(req.url), {}, rpcDeps(table));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bytesWritten: content.length });
    expect(new Uint8Array(await fs.readFile(target))).toEqual(content);
    expect(sent.filter((m) => m.type === "uploadChunkRequest")).toHaveLength(2);
});

test("an ordinary JSON call is unaffected by the multipart path", async () => {
    const table: ApiTable = new Map([["files/listDir", async (data: unknown) => ({ echoed: data })]]);
    const req = new Request("http://localhost/api/files/listDir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "machine-1", path: "/tmp" }),
    });
    const res = await handleRpc(req, new URL(req.url), {}, rpcDeps(table));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ echoed: { serverId: "machine-1", path: "/tmp" } });
});

test("a handler that ignores its binary field doesn't wedge the request", async () => {
    // drain() is what makes this true: bytes are still arriving when the handler
    // returns, and the response can't go out on top of them.
    const table: ApiTable = new Map([["files/upload", async () => ({ ignored: true })]]);
    const req = multipartRequest({ path: "/tmp/whatever", ...oneShot() }, "content", payload(2 * 1024 * 1024));

    const res = await handleRpc(req, new URL(req.url), {}, rpcDeps(table));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ignored: true });
});

test("a malformed multipart body is the caller's error, not a 500", async () => {
    const table: ApiTable = new Map([["files/upload", async () => ({ ok: true })]]);
    const req = new Request("http://localhost/api/files/upload", {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=abc" },
        body: "not actually multipart",
    });

    const res = await handleRpc(req, new URL(req.url), {}, rpcDeps(table));

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/multipart/i);
});

test("permission is settled before a single byte of the body is read", async () => {
    // The operation is named by the URL, so the gate doesn't need the body — and
    // an upload from someone who may not perform it costs nothing to refuse.
    let handlerRan = false;
    const table: ApiTable = new Map([["files/upload", async () => { handlerRan = true; return null; }]]);
    const deps = { ...rpcDeps(table), auth: { authenticate: async () => null } as unknown as ReturnType<typeof rpcDeps>["auth"] };

    const req = multipartRequest({ path: "/tmp/nope", ...oneShot() }, "content", payload(1024));
    const res = await handleRpc(req, new URL(req.url), {}, deps);

    expect(res.status).toBe(401);
    expect(handlerRan).toBe(false);
});
