import type { MountAutoMountInfo, MountInfo, MountsState } from "@central/shared";
import type { HostAgent } from "../../host-agent";

function firstErrorLine(res: { stdout: string; stderr: string }): string {
    return (res.stdout + res.stderr).trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
}

interface FindmntRow {
    source: string;
    target: string;
    fstype: string;
    options: string;
    size: number;
    used: number;
    avail: number;
}

/** Mountpoint → fstab options, skipping comments/blank lines/swap. Matched by
 *  mountpoint (not device) since fstab's device column (UUID=/LABEL=/path) rarely
 *  matches findmnt's resolved source string directly. */
function parseFstab(text: string): Map<string, string[]> {
    const byMountpoint = new Map<string, string[]>();
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        const fields = trimmed.split(/\s+/);
        if (fields.length < 4 || fields[2] === "swap") {
            continue;
        }
        byMountpoint.set(fields[1], fields[3].split(","));
    }
    return byMountpoint;
}

/** Dataset name → canmount value, from `zfs get -H -p -o name,value canmount`. */
function parseCanmount(text: string): Map<string, string> {
    const byDataset = new Map<string, string>();
    for (const line of text.split("\n")) {
        if (!line.trim()) {
            continue;
        }
        const [name, value] = line.split("\t");
        if (name && value) {
            byDataset.set(name, value);
        }
    }
    return byDataset;
}

/**
 * ZFS and fstab-backed mounts use entirely different auto-mount mechanisms —
 * ZFS mounts are governed by `canmount` + zfs-mount.service and normally never
 * appear in /etc/fstab at all, so a ZFS row is judged by canmount and every
 * other row by fstab presence, never both.
 */
function autoMountFor(row: FindmntRow, fstab: Map<string, string[]>, canmount: Map<string, string>): MountAutoMountInfo {
    if (row.fstype === "zfs") {
        const value = canmount.get(row.source);
        if (value === undefined) {
            return { enabled: false, source: "none", detail: "unknown dataset" };
        }
        if (value === "on") {
            return { enabled: true, source: "zfs", detail: "canmount=on" };
        }
        return { enabled: false, source: "zfs", detail: `canmount=${value}` };
    }
    const opts = fstab.get(row.target);
    if (opts === undefined) {
        return { enabled: false, source: "none", detail: "not in /etc/fstab — mounted manually" };
    }
    if (opts.includes("noauto")) {
        return { enabled: false, source: "fstab", detail: "noauto in /etc/fstab" };
    }
    return { enabled: true, source: "fstab", detail: "in /etc/fstab" };
}

/**
 * Every real (non-pseudo) mounted filesystem on the host, with reboot-survival
 * status. `findmnt --real` already excludes proc/sysfs/cgroup/devpts/etc, so no
 * separate filter list needs maintaining here.
 */
export async function getMounts(server: HostAgent): Promise<MountsState> {
    const probe = await server.exec("findmnt --version 2>&1");
    if (probe.code !== 0) {
        return { available: false, error: firstErrorLine(probe) || "findmnt is not available on this host", mounts: [] };
    }

    const [findmntRes, fstabRes, canmountRes] = await Promise.all([
        server.exec("findmnt -J -l --real -b -o SOURCE,TARGET,FSTYPE,OPTIONS,SIZE,USED,AVAIL 2>&1"),
        server.exec("cat /etc/fstab 2>/dev/null"),
        // Fails harmlessly (empty stdout) on hosts without ZFS — no exit-code check needed.
        server.exec("zfs get -H -p -o name,value canmount 2>/dev/null"),
    ]);
    if (findmntRes.code !== 0) {
        return { available: false, error: firstErrorLine(findmntRes) || "findmnt failed", mounts: [] };
    }

    let rows: FindmntRow[];
    try {
        rows = (JSON.parse(findmntRes.stdout) as { filesystems?: FindmntRow[] }).filesystems ?? [];
    } catch {
        return { available: false, error: "Could not parse findmnt output", mounts: [] };
    }

    const fstab = parseFstab(fstabRes.stdout);
    const canmount = parseCanmount(canmountRes.stdout);

    const mounts: MountInfo[] = rows.map((r) => ({
        device: r.source,
        mountpoint: r.target,
        fstype: r.fstype,
        options: r.options ? r.options.split(",") : [],
        sizeBytes: r.size ?? 0,
        usedBytes: r.used ?? 0,
        availBytes: r.avail ?? 0,
        autoMount: autoMountFor(r, fstab, canmount),
    }));
    mounts.sort((a, b) => a.mountpoint.localeCompare(b.mountpoint));

    return { available: true, mounts };
}
