import type { LogQuery, ServiceAction, ServiceInfo, SystemdState } from "@central/shared";
import type { ExecResult, HostAgent } from "../../host-agent";
import { journalPriority, journalSince } from "../../log-query";

// Unit names: letters, digits, and the punctuation systemd allows (`. _ - @ : \`).
const SAFE_UNIT_RE = /^[A-Za-z0-9_.@:\\-]+$/;

function assertUnit(unit: string): void {
    if (!SAFE_UNIT_RE.test(unit)) {
        throw new Error(`Invalid unit name: ${unit}`);
    }
}

/** The verbs `systemdServiceAction` will run. `ServiceAction` is a compile-time
 *  claim only — the API surface casts a parsed JSON body to it without checking
 *  — so the action is interpolated into the command unvalidated without this. */
const SERVICE_ACTIONS: readonly ServiceAction[] = ["start", "stop", "restart", "enable", "disable"];

function assertServiceAction(action: ServiceAction): void {
    if (!SERVICE_ACTIONS.includes(action)) {
        throw new Error(`Unsupported service action: ${action}`);
    }
}

/**
 * What the log and unit-file viewers should display. On success that's stdout;
 * on failure the tool's error text *is* the useful content, and it's on stderr
 * now that these commands no longer fold it into stdout with `2>&1`. Without
 * this the viewer would show an empty pane instead of "Unit foo.service could
 * not be found."
 *
 * The success case is better than the old merge, too: journalctl's own warnings
 * no longer land in the middle of the log the operator is reading.
 */
function outputOrError(res: ExecResult): string {
    return res.code === 0 ? res.stdout : [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
}

/**
 * List service units with their runtime state (from `list-units`) merged with the
 * enabled/disabled state (from `list-unit-files`). Both use `--plain` so there's
 * no leading status bullet to strip.
 */
export async function systemdList(server: HostAgent): Promise<SystemdState> {
    const probe = await server.run(["systemctl", "--version"]);
    if (probe.code !== 0) {
        return {
            available: false,
            error: (probe.stdout + probe.stderr).trim().split("\n")[0] || "systemd unavailable",
            services: [],
        };
    }

    const [units, files] = await Promise.all([
        server.run(["systemctl", "list-units", "--type=service", "--all", "--no-legend", "--no-pager", "--plain"]),
        server.run(["systemctl", "list-unit-files", "--type=service", "--no-legend", "--no-pager", "--plain"]),
    ]);

    // unit name → enabled state (enabled | disabled | static | masked | …).
    const enabledByUnit = new Map<string, string>();
    for (const line of files.stdout.split("\n")) {
        const f = line.trim().split(/\s+/);
        if (f.length >= 2) {
            enabledByUnit.set(f[0], f[1]);
        }
    }

    const services: ServiceInfo[] = [];
    for (const line of units.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        // UNIT LOAD ACTIVE SUB DESCRIPTION… (unit names never contain spaces).
        const f = trimmed.split(/\s+/);
        if (f.length < 4) {
            continue;
        }
        services.push({
            unit: f[0],
            load: f[1],
            active: f[2],
            sub: f[3],
            description: f.slice(4).join(" "),
            enabledState: enabledByUnit.get(f[0]),
        });
    }

    services.sort((a, b) => a.unit.localeCompare(b.unit));
    return { available: true, services };
}

export async function systemdServiceAction(
    server: HostAgent,
    unit: string,
    action: ServiceAction,
    onLog?: (text: string) => void,
): Promise<void> {
    assertUnit(unit);
    assertServiceAction(action);
    const res = await server.run(["systemctl", action, unit]);
    onLog?.(res.stdout);
    if (res.code !== 0) {
        throw new Error((res.stdout + res.stderr).trim().split("\n").pop() || `systemctl ${action} failed`);
    }
}

export async function systemdServiceLogs(
    server: HostAgent,
    unit: string,
    opts: LogQuery & { priority?: string },
): Promise<string> {
    assertUnit(unit);
    // One argv element per token: `--output short-iso` is two, and `--since` and
    // its value are two more. Folding a flag and its value into one string was
    // fine for a shell to re-split and is a single bogus argument here.
    const args = ["-u", unit, "-n", String(Math.floor(opts.limit ?? 300)), "--no-pager", "--output", "short-iso"];
    const since = journalSince(opts.since);
    if (since) {
        args.push("--since", since);
    }
    const priority = journalPriority(opts.priority);
    if (priority) {
        args.push("-p", priority);
    }
    if (opts.order === "newest") {
        args.push("--reverse");
    }
    return outputOrError(await server.run(["journalctl", ...args]));
}

export async function systemdUnitFile(server: HostAgent, unit: string): Promise<string> {
    assertUnit(unit);
    return outputOrError(await server.run(["systemctl", "cat", unit]));
}
