// ---- Files -------------------------------------------------------------------

export type DirEntryType = "file" | "dir" | "symlink" | "other";

export interface DirEntry {
    name: string;
    type: DirEntryType;
    sizeBytes: number;
    /** ms epoch */
    modifiedAt: number;
    /** e.g. "rwxr-xr-x" */
    permissions: string;
}

/** How a device node is likely to be used, so the picker can group and explain
 *  the list instead of showing bare paths. Derived from the path alone — nothing
 *  here opens the device to ask it what it is. */
export type HostDeviceKind = "serial" | "gpu" | "video" | "tun" | "other";

/** A device node on a host that could be mapped into a container (compose's
 *  `devices:`). Produced by scanning a fixed set of `/dev` locations — see
 *  `features/files/host-devices.ts`; it is not a full `/dev` listing. */
export interface HostDevice {
    /** The path to map. The stable `/dev/serial/by-id/...` symlink when the
     *  device has one — USB serial nodes get renumbered across reboots and
     *  re-plugs, so the raw `/dev/ttyACM0` is the wrong thing to write into a
     *  compose file when a by-id name exists. */
    path: string;
    /** The device node `path` ultimately points at, e.g. `/dev/ttyACM0`. Equal
     *  to `path` when it isn't reached through a symlink. */
    node: string;
    kind: HostDeviceKind;
    /** Other paths reaching the same node — the raw node behind a by-id symlink,
     *  or a second by-id alias for a multi-interface adapter. */
    aliases: string[];
    /** Human name recovered from the by-id filename (e.g. "dresden elektronik
     *  ingenieurtechnik GmbH ConBee II DE2667394"), absent when there's no such
     *  name to read one from. */
    label?: string;
}

export interface HostDevices {
    devices: HostDevice[];
    /** Set when the scan itself failed; `devices` is empty then. An empty list
     *  with no error means the host genuinely has none of the scanned nodes. */
    error?: string;
}

export interface FileContent {
    path: string;
    /** Text (utf8) or, for images, the base64-encoded bytes (see `encoding`). */
    content: string;
    sizeBytes: number;
    truncated: boolean;
    /** True when the file looks binary; content will be empty unless it's an image. */
    binary: boolean;
    /** How `content` is encoded. Absent means plain utf8 text. */
    encoding?: "base64";
    /** MIME type for renderable files (currently images), e.g. "image/png". */
    mimeType?: string;
}

// ---- Mounts ------------------------------------------------------------------------
//
// Every real (non-pseudo) filesystem currently mounted on a host — driven by
// `findmnt --real` on the agent (see apps/server/src/host-mounts.ts), cross-checked
// against /etc/fstab and, for ZFS mounts, `zfs get canmount` to answer "will this
// survive a reboot" — the two mechanisms don't overlap (ZFS mounts are governed by
// zfs-mount.service, not fstab, and normally never appear in fstab at all).

export interface MountAutoMountInfo {
    /** Whether this mount is expected to come back after a reboot. */
    enabled: boolean;
    /** What mechanism (if any) is responsible. */
    source: "fstab" | "zfs" | "none";
    /** Human-readable reason, e.g. "noauto in /etc/fstab", "canmount=off". */
    detail: string;
}

export interface MountInfo {
    /** findmnt's "source" — a block device path, a ZFS dataset name, "tmpfs", etc. */
    device: string;
    mountpoint: string;
    fstype: string;
    options: string[];
    sizeBytes: number;
    usedBytes: number;
    availBytes: number;
    autoMount: MountAutoMountInfo;
}

export interface MountsState {
    /** False when `findmnt` isn't present (non-Linux hosts). */
    available: boolean;
    error?: string;
    mounts: MountInfo[];
}


// ---- Operations ----------------------------------------------------------------

export interface FilesOperations {
    listDir: { data: { serverId: string; path: string }; response: { path: string; entries: DirEntry[] } };
    read: { data: { serverId: string; path: string }; response: FileContent };
    write: { data: { serverId: string; path: string; content: string }; response: void };
    // Upload raw bytes (base64-encoded) — binary-safe, unlike writeFile's utf8 text.
    upload: { data: { serverId: string; path: string; contentBase64: string }; response: void };
    createDir: { data: { serverId: string; path: string }; response: void };
    delete: { data: { serverId: string; path: string }; response: void };
    rename: { data: { serverId: string; from: string; to: string }; response: void };
    // Mounts — every real filesystem currently mounted, and whether it'll survive a reboot.
    getMounts: { data: { serverId: string }; response: MountsState };
    // Mappable device nodes (`/dev/serial/by-id`, tty, dri, video, tun) — what the
    // compose editor's `devices:` picker offers, not a full /dev listing.
    listDevices: { data: { serverId: string }; response: HostDevices };
}
