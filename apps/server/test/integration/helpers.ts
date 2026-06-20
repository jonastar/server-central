import * as path from "node:path";
import type { Subprocess } from "bun";
import type { NodeMessage } from "@central/shared";

/** The real agent CLI entry (apps/node/src/index.ts), relative to this file. */
const AGENT_ENTRY = path.resolve(import.meta.dir, "../../../node/src/index.ts");

/**
 * Poll `fn` until it returns a truthy value or the timeout elapses.
 * Returns the truthy value; throws on timeout.
 */
export async function poll<T>(
    fn: () => T | Promise<T>,
    opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<NonNullable<T>> {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const intervalMs = opts.intervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
        try {
            const value = await fn();
            if (value) return value as NonNullable<T>;
        } catch (err) {
            lastErr = err;
        }
        await Bun.sleep(intervalMs);
    }
    const suffix = opts.label ? ` waiting for ${opts.label}` : "";
    throw new Error(`poll timed out${suffix}${lastErr ? `: ${lastErr}` : ""}`);
}

export interface SpawnedAgent {
    proc: Subprocess;
    /** Drained stdout+stderr so far (useful when a test fails). */
    output: () => string;
    stop: () => Promise<void>;
}

/**
 * Spawn the real agent CLI as a subprocess — the same `connect` entry point the
 * production node binary uses, run from source (no compile step). Exercises real
 * arg parsing, the WsTransport, the connect/reconnect loop, and startMetrics().
 */
export function spawnTestAgent(opts: { control: string; token: string; certPath: string }): SpawnedAgent {
    const proc = Bun.spawn(
        ["bun", AGENT_ENTRY, "connect", "--control", opts.control, "--token", opts.token, "--cert", opts.certPath],
        { stdout: "pipe", stderr: "pipe" },
    );

    const chunks: string[] = [];
    const decoder = new TextDecoder();
    for (const stream of [proc.stdout, proc.stderr]) {
        if (stream instanceof ReadableStream) {
            void (async () => {
                for await (const chunk of stream) chunks.push(decoder.decode(chunk));
            })();
        }
    }

    return {
        proc,
        output: () => chunks.join(""),
        stop: async () => {
            proc.kill();
            await proc.exited;
        },
    };
}

/**
 * Open a raw TLS WebSocket and attempt the identify handshake directly, without
 * a full Agent. Used to assert the server's token validation (rejection) path.
 */
export function attemptIdentify(opts: {
    port: number;
    certPem: string;
    token: string;
}): Promise<{ acknowledged: boolean; closeCode: number | null }> {
    const { port, certPem, token } = opts;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://127.0.0.1:${port}/node`, {
            // @ts-expect-error Bun-specific TLS option
            tls: { ca: certPem },
        });
        // Guard so a synchronous onclose (fired by ws.close()) can't override an
        // already-acknowledged result.
        let settled = false;
        const done = (result: { acknowledged: boolean; closeCode: number | null }) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        const info = { hostname: "negative-test", os: "", kernel: "", arch: "", primaryIp: "", cpuModel: "", cpuCores: 0, uptimeSeconds: 0, capturedAt: Date.now() };
        ws.onopen = () => ws.send(JSON.stringify({ type: "identify", token, info, machineId: "negative-test", mode: "live" } satisfies NodeMessage));
        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(String(event.data));
                if (msg.type === "acknowledged") {
                    done({ acknowledged: true, closeCode: null });
                    ws.close();
                }
            } catch { /* ignore */ }
        };
        ws.onclose = (event) => done({ acknowledged: false, closeCode: event.code ?? null });
        ws.onerror = () => reject(new Error("WebSocket error during identify"));
    });
}
