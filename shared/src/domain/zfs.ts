// ---- ZFS -------------------------------------------------------------------------
//
// Full pool/vdev/dataset/snapshot lifecycle, driven by shelling `zpool`/`zfs` on the
// agent's host (see apps/server/src/features/zfs/zfs.ts) — the same "parse a CLI" shape as
// docker.ts/systemd.ts, not a new protocol message. Design: doc/idea_zfs.md.
// Pool/vdev topology mutations run through the task system (see TaskSpec's zfs_*
// variants) for an audit trail and are gated owner-only by the ZFS feature; dataset/
// snapshot mutations run the same way but aren't role-gated (matching the rest of
// the task system today — see the Role doc comment below on per-op RBAC).

export type ZfsHealth = "ONLINE" | "DEGRADED" | "FAULTED" | "OFFLINE" | "UNAVAIL" | "REMOVED";

export interface ZfsDevice {
    /** A `/dev/disk/by-id/*` path where resolvable, else the raw name zpool printed. */
    name: string;
    type: "disk" | "file" | "spare" | "cache" | "log";
    state: ZfsHealth;
    readErrors: number;
    writeErrors: number;
    checksumErrors: number;
}

export type ZfsVdevType = "stripe" | "mirror" | "raidz1" | "raidz2" | "raidz3" | "spare" | "log" | "cache";

export interface ZfsVdev {
    type: ZfsVdevType;
    state: ZfsHealth;
    devices: ZfsDevice[];
}

export interface ZfsScanStatus {
    kind: "scrub" | "resilver";
    state: "in_progress" | "completed" | "cancelled";
    startedAt: number;
    finishedAt?: number;
    pctDone?: number;
    eta?: string;
}

export interface ZfsPool {
    name: string;
    state: ZfsHealth;
    sizeBytes: number;
    allocatedBytes: number;
    freeBytes: number;
    fragmentationPct: number;
    capacityPct: number;
    /** Raw summary line from `zpool status`, e.g. "No known data errors". */
    errors: string;
    scan: ZfsScanStatus | null;
    vdevs: ZfsVdev[];
}

export interface ZfsDataset {
    name: string; // "tank/media"
    pool: string;
    type: "filesystem" | "volume";
    usedBytes: number;
    availBytes: number;
    referBytes: number;
    mountpoint: string | null;
    mounted: boolean;
    /** Whether ZFS auto-mounts this dataset at import/boot (via zfs-mount.service —
     *  distinct from /etc/fstab, which ZFS mounts normally don't appear in at all).
     *  "noauto" means mountable but excluded from `zfs mount -a`. */
    canmount: "on" | "off" | "noauto";
    compression: string;
    compressRatio: number;
    quotaBytes: number | null;
    recordsize?: number; // filesystem only
    volsizeBytes?: number; // volume (zvol) only
    /** Parent snapshot, if this dataset is a clone. */
    origin?: string;
}

export interface ZfsSnapshot {
    name: string; // "tank/media@2026-08-12"
    dataset: string;
    createdAt: number;
    usedBytes: number;
    referBytes: number;
}

export interface ZfsBlockDevice {
    name: string; // "sda"
    /** `/dev/disk/by-id/*` paths for this device — preferred for all pool/vdev ops
     *  since `/dev/sdX` ordering isn't stable across reboots. */
    byIdPaths: string[];
    sizeBytes: number;
    model: string;
    serial: string;
    rotational: boolean;
    inUse: "zfs" | "mounted" | "partitioned" | null;
    /** e.g. pool name or mountpoint, when inUse is set. */
    inUseDetail?: string;
}

export interface ZfsState {
    /** False when the `zpool`/`zfs` binaries aren't present — most hosts outside
     *  TrueNAS/ZFS-on-Linux setups. The ZFS tab grays out rather than erroring. */
    available: boolean;
    error?: string;
    pools: ZfsPool[];
}


/**
 * Read-only + low-risk direct ops. Pool/vdev/dataset/snapshot mutations go
 * through the task system (runTask with a zfs_* spec) instead, for the audit
 * trail — see doc/idea_zfs.md.
 */
export interface ZfsOperations {
    getState: { data: { serverId: string }; response: ZfsState };
    getDatasets: { data: { serverId: string; pool?: string }; response: ZfsDataset[] };
    getSnapshots: { data: { serverId: string; dataset?: string }; response: ZfsSnapshot[] };
    getBlockDevices: { data: { serverId: string }; response: ZfsBlockDevice[] };
    setDatasetProperty: { data: { serverId: string; name: string; key: string; value: string }; response: void };
}
