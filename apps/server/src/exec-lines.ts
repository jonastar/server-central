import type { ExecOptions, ExecResult, HostAgent } from "./host-agent";

/**
 * Run a command with its output reaching `onLog` a line at a time, as the
 * command produces it, instead of in one lump once it finishes.
 *
 * The line buffering is the point: {@link HostAgent.runStream} hands over raw
 * chunks, which split lines at arbitrary byte boundaries, while a task log line
 * is supposed to be a line. Each stream gets its own buffer, so a half-written
 * stdout line can't be completed by the next stderr chunk; `onLog` is told which
 * stream a line came from, and callers that don't care can ignore it.
 *
 * Against an agent too old to stream this degrades to one call with everything,
 * at the end — see the fallbacks in {@link HostAgent.runStream}.
 */
export async function runStreamingLines(
    server: HostAgent,
    argv: string[],
    onLog?: (text: string, stream: "stdout" | "stderr") => void,
    opts?: ExecOptions,
): Promise<ExecResult> {
    if (!onLog) {
        return server.runStream(argv, () => { /* nobody listening; still streamed, just not forwarded */ }, opts);
    }
    const buffered: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };
    const res = await server.runStream(argv, (stream, data) => {
        const lines = (buffered[stream] + data).split("\n");
        // The trailing element is whatever came after the last newline — an
        // incomplete line, held back until the rest of it arrives.
        buffered[stream] = lines.pop() ?? "";
        for (const line of lines) {
            onLog(line, stream);
        }
    }, opts);
    for (const stream of ["stdout", "stderr"] as const) {
        if (buffered[stream].trim()) {
            onLog(buffered[stream], stream);
        }
    }
    return res;
}
