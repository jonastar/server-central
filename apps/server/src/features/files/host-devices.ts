import type { HostDevice, HostDeviceKind, HostDevices } from "@central/shared";
import type { HostAgent } from "../../host-agent";

/**
 * Where devices worth mapping into a container actually live. A full `/dev`
 * listing would be hundreds of kernel pseudo-nodes with the two or three an
 * operator cares about buried in it, so this is a fixed shortlist rather than a
 * walk: USB serial adapters (Zigbee/Z-Wave sticks — the ConBee/SkyConnect case),
 * GPU render nodes (hardware transcoding), V4L capture devices, and the TUN
 * node (VPN containers).
 *
 * `/dev/serial/by-id` comes first deliberately: its entries are symlinks whose
 * names survive reboots and re-plugs, unlike the `/dev/ttyACM0` they point at,
 * and the dedupe below prefers whichever path was seen first for a given node.
 */
const DEVICE_GLOBS = [
    "/dev/serial/by-id/*",
    "/dev/ttyACM*",
    "/dev/ttyUSB*",
    "/dev/ttyAMA*",
    "/dev/dri/*",
    "/dev/video*",
    "/dev/net/tun",
];

function classify(path: string): HostDeviceKind {
    if (path.startsWith("/dev/serial/") || /^\/dev\/tty(ACM|USB|AMA)/.test(path)) {
        return "serial";
    }
    if (path.startsWith("/dev/dri/")) {
        return "gpu";
    }
    if (/^\/dev\/video\d+$/.test(path)) {
        return "video";
    }
    if (path === "/dev/net/tun") {
        return "tun";
    }
    return "other";
}

/**
 * Recovers a readable name from a by-id filename:
 * `usb-dresden_elektronik_ingenieurtechnik_GmbH_ConBee_II_DE2667394-if00` →
 * "dresden elektronik ingenieurtechnik GmbH ConBee II DE2667394". The `-ifNN`
 * suffix is the USB interface number, not part of the product name — it's
 * dropped from the label but never from the path, where it's what distinguishes
 * two interfaces of the same adapter.
 */
function labelFor(path: string): string | undefined {
    if (!path.startsWith("/dev/serial/by-id/")) {
        return undefined;
    }
    const name = path.slice("/dev/serial/by-id/".length)
        .replace(/^usb-/, "")
        .replace(/-if\d+(-port\d+)?$/, "")
        .replace(/_/g, " ")
        .trim();
    return name || undefined;
}

/**
 * Device nodes on the host that can be mapped into a container.
 *
 * One `sh` loop rather than a command per glob — a glob that matches nothing
 * expands to itself in `sh`, which the `-e` test filters back out. Each line is
 * `<path>\t<resolved node>`; resolution matters because several paths routinely
 * reach the same node (a by-id symlink and the raw tty), and mapping both into a
 * container would be the same device twice under two names.
 */
export async function listHostDevices(server: HostAgent): Promise<HostDevices> {
    const script = `for p in ${DEVICE_GLOBS.join(" ")}; do [ -e "$p" ] || continue; printf '%s\\t%s\\n' "$p" "$(readlink -f "$p" 2>/dev/null || echo "$p")"; done`;
    const res = await server.exec(`${script} 2>/dev/null`);
    if (res.code !== 0) {
        const detail = (res.stderr || res.stdout).trim().split("\n").pop() ?? "";
        return { devices: [], error: detail || "Could not scan /dev on this host" };
    }

    // Keyed by resolved node: the first path seen for a node wins (DEVICE_GLOBS
    // is ordered so that's the stable by-id name when the device has one) and
    // every later path for the same node becomes an alias.
    const byNode = new Map<string, HostDevice>();
    for (const line of res.stdout.split("\n")) {
        const [path, node] = line.split("\t");
        if (!path || !node) {
            continue;
        }
        const existing = byNode.get(node);
        if (existing) {
            if (existing.path !== path && !existing.aliases.includes(path)) {
                existing.aliases.push(path);
                // A by-id name can turn up after the raw node (a glob ordering
                // change, an unusual layout) — take the label wherever it appears.
                existing.label ??= labelFor(path);
            }
            continue;
        }
        byNode.set(node, { path, node, kind: classify(path), aliases: [], label: labelFor(path) });
    }

    const devices = [...byNode.values()].sort((a, b) => a.path.localeCompare(b.path));
    return { devices };
}
