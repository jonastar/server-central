import type { ServiceAction, ServiceInfo, SystemdState } from "@central/shared";
import type { HostAgent } from "./host-agent";

// Unit names: letters, digits, and the punctuation systemd allows (`. _ - @ : \`).
const SAFE_UNIT_RE = /^[A-Za-z0-9_.@:\\-]+$/;

function assertUnit(unit: string): void {
    if (!SAFE_UNIT_RE.test(unit)) {
        throw new Error(`Invalid unit name: ${unit}`);
    }
}

/**
 * List service units with their runtime state (from `list-units`) merged with the
 * enabled/disabled state (from `list-unit-files`). Both use `--plain` so there's
 * no leading status bullet to strip.
 */
export async function systemdList(server: HostAgent): Promise<SystemdState> {
    const probe = await server.exec("systemctl --version 2>&1");
    if (probe.code !== 0) {
        return {
            available: false,
            error: (probe.stdout + probe.stderr).trim().split("\n")[0] || "systemd unavailable",
            services: [],
        };
    }

    const [units, files] = await Promise.all([
        server.exec("systemctl list-units --type=service --all --no-legend --no-pager --plain"),
        server.exec("systemctl list-unit-files --type=service --no-legend --no-pager --plain"),
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
): Promise<void> {
    assertUnit(unit);
    const res = await server.exec(`systemctl ${action} ${unit} 2>&1`);
    if (res.code !== 0) {
        throw new Error((res.stdout + res.stderr).trim().split("\n").pop() || `systemctl ${action} failed`);
    }
}

export async function systemdServiceLogs(
    server: HostAgent,
    unit: string,
    lines: number,
): Promise<string> {
    assertUnit(unit);
    const res = await server.exec(`journalctl -u ${unit} -n ${Math.floor(lines)} --no-pager --output short-iso 2>&1`);
    return res.stdout;
}

export async function systemdUnitFile(server: HostAgent, unit: string): Promise<string> {
    assertUnit(unit);
    const res = await server.exec(`systemctl cat ${unit} 2>&1`);
    return res.stdout;
}
