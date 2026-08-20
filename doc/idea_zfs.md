# ZFS Integration

Status: idea / design. Not yet scheduled. Sibling of
[idea_backup_secrets.md](idea_backup_secrets.md) — its §7 "Quiescing" note
("SC must stop the stack before capture, or snapshot at the filesystem layer —
ZFS is available on the TrueNAS hosts") is the first real consumer of the
snapshot half of this design.

## Concept and scope

A **ZFS** tab, per server, alongside Docker/Systemd/Processes: full ZFS
lifecycle management — pools, vdevs, datasets/zvols, snapshots — not just a
capacity readout. `DiskUsage` in `shared/src/index.ts` today is `df`-derived
and has no concept of a pool or dataset; this introduces one.

Named **ZFS**, not "Storage" — same call `idea_reverse_proxy.md` made on
Caddy vs. Traefik ("no pluggable-backend layer... swapping engines later only
means swapping the renderer"). The vdev/scrub/dataset model here is
ZFS-shaped end to end and doesn't map cleanly onto btrfs subvolumes or LVM
PVs/VGs, so a generic storage abstraction would be built against a guess, not
a second real backend. A host without ZFS just shows the tab grayed out
(`ZfsState.available: false`); btrfs/LVM support, if it ever happens, is a
separate tab of its own rather than a variant of this one.

This is the highest blast-radius feature in the app. Every other integration
(`docker.ts`, `systemd.ts`, `proxy/`) touches things that are cheap to redo —
a container restarts, a route re-renders. `zpool destroy` and `zfs destroy -r`
are not that: run against the wrong pool from the wrong host in a fleet UI and
the data is gone, not "reconciled." **Safety rails are not a v2 concern
layered on later — they gate what ships in v1 at all** (see "Safety model").

## Transport: no new protocol message

Same shape as `docker.ts`/`systemd.ts`: the agent already runs `exec` as root,
so `zpool`/`zfs` CLI calls need nothing new in `node-protocol.ts`. Parse with
`-H` (no header) and, where available, `-p` (exact byte values, not "10.5G"
strings) — e.g. `zfs list -H -p -o name,used,avail,refer,mountpoint,...`,
`zpool list -H -p -o name,size,alloc,free,fragmentation,capacity,health`.
Newer OpenZFS (2.2+) has `-j`/`--json` on `zpool status`/`zpool list`; **don't
depend on it** — TrueNAS SCALE and older ZFS-on-Linux installs in a homelab
fleet are exactly the hosts this needs to work on, and `-H -p` is supported
since ZoL 0.6.x. `zpool status` has no tabular flag at all — parse its indented
tree output for vdevs/devices (mirrors what `zpool_influxdb` and every other
third-party ZFS UI already does; there is no better option upstream).

## Safety model

This is the part of the doc that matters most.

1. **No silent `-f`.** `zpool create -f`, `zpool destroy`, `zfs destroy -r` —
   force flags never appear in generated commands. If ZFS refuses an op for a
   reason a force-flag would paper over (disk has a partition table, pool
   already imported elsewhere), SC surfaces the refusal and requires the
   operator to resolve it out of band, not a checkbox that adds `-f`.
2. **Type-to-confirm on anything that destroys data**: pool destroy, dataset
   destroy, snapshot rollback (which implicitly destroys every snapshot newer
   than the rollback target — show that count before confirming, don't let it
   be a surprise). The confirm text is the pool/dataset name, not a generic
   "Are you sure?".
3. **By-id, never `/dev/sdX`.** `/dev/sdX` ordering isn't stable across
   reboots — building a pool from `/dev/sdb`/`/dev/sdc` is a well-known way to
   degrade a pool after the next reboot reorders things. The disk picker
   (`getZfsBlockDevices`) surfaces `/dev/disk/by-id/*` paths and `zpool
   create`/`add`/`replace` are only ever generated with those.
4. **In-use disks are visibly blocked, not just discouraged.** Block-device
   enumeration cross-checks each candidate disk against `zpool status` (every
   host's pools, not just the target's — a disk can't lie about being free)
   and the host's mount table, and disables selection with a reason
   ("already in tank as raidz1 member", "mounted at /", "has partition
   table") rather than letting the operator find out via a ZFS error after
   the fact.
5. **Every mutation runs through the task system**, even the ones that
   complete in milliseconds — the point isn't latency, it's the audit trail
   ("who destroyed pool `tank`, from which account, when"). No mutating ZFS
   op is a bare request/response RPC.
6. **Role gating**: pool/vdev topology changes (create, destroy, add vdev,
   replace device, import/export) are **owner-only**. Dataset/zvol/snapshot
   CRUD and property edits are owner+admin. Operator/viewer get read-only
   pool/dataset/snapshot views — consistent with the coarse roles already
   described in `shared/src/index.ts` (§ Auth & users).

## Data model (`shared/src/index.ts`)

```ts
export type ZfsHealth = "ONLINE" | "DEGRADED" | "FAULTED" | "OFFLINE" | "UNAVAIL" | "REMOVED";

export interface ZfsDevice {
    /** by-id path where known, else the raw name zpool status printed. */
    name: string;
    type: "disk" | "file" | "spare" | "cache" | "log";
    state: ZfsHealth;
    readErrors: number;
    writeErrors: number;
    checksumErrors: number;
}

export interface ZfsVdev {
    type: "stripe" | "mirror" | "raidz1" | "raidz2" | "raidz3" | "spare" | "log" | "cache";
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
    /** Raw summary line, e.g. "No known data errors". */
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
    byIdPaths: string[]; // preferred for all pool/vdev ops
    sizeBytes: number;
    model: string;
    serial: string;
    rotational: boolean;
    inUse: "zfs" | "mounted" | "partitioned" | null;
    /** e.g. pool name or mountpoint, when inUse is set. */
    inUseDetail?: string;
}

export interface ZfsState {
    available: boolean; // false when no `zpool`/`zfs` binaries — most non-TrueNAS hosts
    error?: string;
    pools: ZfsPool[];
}
```

Same `{ available, error, ... }` envelope `DockerState`/`SystemdState`/
`NetworkInfo` already use — most hosts in a homelab fleet won't have ZFS at
all, and the ZFS tab should gray out cleanly rather than error.

## Operations

Read-only and low-risk direct ops (`CentralApiOperations`, alongside the
existing `docker*`/`systemd*` entries):

```ts
getZfsState: { data: { serverId: string }; response: ZfsState };
getZfsDatasets: { data: { serverId: string; pool?: string }; response: ZfsDataset[] };
getZfsSnapshots: { data: { serverId: string; dataset?: string }; response: ZfsSnapshot[] };
getZfsBlockDevices: { data: { serverId: string }; response: ZfsBlockDevice[] };
setDatasetProperty: { data: { serverId: string; name: string; key: string; value: string }; response: void };
```

Everything that mutates pool/vdev/dataset/snapshot state goes through the
task system (`TaskSpec` in `shared/src/tasks.ts`) for the audit trail called
out in the safety model, not as bare RPCs:

```ts
| { kind: "zfs_pool_create"; name: string; vdevs: { type: ZfsVdev["type"]; devices: string[] /* by-id */ }[] }
| { kind: "zfs_pool_destroy"; name: string }
| { kind: "zfs_pool_import"; name: string }
| { kind: "zfs_pool_export"; name: string }
| { kind: "zfs_vdev_add"; pool: string; vdev: { type: ZfsVdev["type"]; devices: string[] } }
| { kind: "zfs_device_replace"; pool: string; oldDevice: string; newDevice: string }
| { kind: "zfs_scrub"; pool: string; action: "start" | "stop" }
| { kind: "zfs_dataset_create"; parent: string; name: string; type: "filesystem" | "volume"; volsizeBytes?: number; properties?: Record<string, string> }
| { kind: "zfs_dataset_destroy"; name: string; recursive: boolean }
| { kind: "zfs_snapshot_create"; dataset: string; name: string; recursive: boolean }
| { kind: "zfs_snapshot_rollback"; snapshot: string }
| { kind: "zfs_snapshot_destroy"; snapshot: string }
| { kind: "zfs_snapshot_clone"; snapshot: string; target: string }
```

`zfs_scrub` completing quickly (the command just kicks off a background scan)
means status is polled the same way the reverse-proxy doc polls a detached
deploy: `ZfsPool.scan` reflects the live `zpool status` scan line on the next
`getZfsState` poll, no separate "scrub progress" op needed.

## UI sketch

New **ZFS** tab per server:

1. **Pools overview** — one card per pool: health badge, capacity bar,
   fragmentation, active scrub/resilver progress if any.
2. **Pool detail** — vdev tree mirroring `zpool status`'s own tree (pool →
   vdevs → devices), per-device state and error counts, "Scrub" button,
   "Replace device" (opens the by-id disk picker, in-use disks disabled with
   reason), "Export" / "Destroy pool" (owner-only, type-pool-name-to-confirm).
3. **Create pool wizard** (owner-only, separate flow) — pick disks from
   `getZfsBlockDevices`, choose vdev layout, warn on non-redundant (single
   stripe) layouts, show the literal `zpool create` command that will run
   before confirming.
4. **Datasets tab** — table (name, used/avail, mountpoint, compression),
   create dataset/zvol form, property editor, per-row "Snapshot now" /
   "Destroy" (confirm).
5. **Snapshots tab** — dataset-grouped list, create/rollback/clone/destroy;
   rollback shows "this destroys N newer snapshots" before confirming.

## Interaction with the backup design

Once dataset-scoped `zfs_snapshot_create`/`rollback` exist,
`idea_backup_secrets.md` §7's "or snapshot at the filesystem layer" stops
being aspirational: the backup flow can offer ZFS snapshot as an alternative
to stop-the-container quiescing for `captured` volumes that happen to live on
a ZFS dataset — cross-reference that doc's build order once this lands.

## Open questions

- **TrueNAS hosts already manage ZFS via `midclt`/middleware**, which keeps
  its own state cache on top of the pool. Shelling straight to `zpool`/`zfs`
  (as this doc assumes, for portability across plain-Linux and TrueNAS hosts
  alike) risks drifting from what TrueNAS's own UI believes. Leaning "raw CLI
  everywhere, flag TrueNAS as a known rough edge" for v1 rather than
  detecting-and-branching to `midclt` — revisit if it actually bites.
- Send/receive replication (pool-to-pool, host-to-host) is deliberately left
  out of this pass — it's long-running/streaming like the reverse-proxy
  doc's deploy-log problem, and probably wants whatever streaming-exec
  upgrade `idea_stack_registry.md` ends up building, not `exec`'s 30s
  timeout. Replication target (another SC node vs. arbitrary SSH host) is
  also unresolved.
- Encryption-at-rest (`zfs create -o encryption=...`) touches key management,
  which overlaps with `idea_backup_secrets.md`'s master-key story — v1
  checkbox or explicitly punt to v2?
- Whether non-owner roles should be able to trigger a scrub (read-only-ish,
  but it's a sustained I/O load an operator could use to degrade a shared
  host) — leaning owner+admin, same as dataset CRUD.
- L2ARC/SLOG (cache/log vdevs) get modeled in `ZfsVdev.type` above but no
  dedicated add-flow is sketched yet; likely folds into "Add vdev" once that
  exists.

## Build order

1. Shared types + `apps/server/src/features/zfs/zfs.ts` parsing module + read-only ops
   (`getZfsState`, `getZfsDatasets`, `getZfsSnapshots`) + ZFS tab
   showing pools/datasets/snapshots, no mutations. Ships real value
   immediately and is the checkpoint to pressure-test parsing against real
   `zpool status` output (raidz trees, degraded members, active resilver)
   before anything destructive is built on top.
2. `getZfsBlockDevices` (`lsblk`-based enumeration + by-id resolution) with
   the in-use cross-check against every pool's members and the mount table —
   required before any disk-touching UI can exist at all.
3. Non-destructive dataset mutations: create dataset/zvol, `setDatasetProperty`.
4. Snapshot lifecycle via the task system — the piece
   `idea_backup_secrets.md` is actually waiting on.
5. Pool/vdev lifecycle (create, destroy, import/export, add vdev, replace
   device) — highest risk, ships last, once steps 1–2's safety rails exist.
   Owner-only, type-to-confirm throughout.
6. Scrub control, folded into pool detail once scan-status polling
   (already needed for step 1's display) is proven out.

## Files touched

- [`shared/src/index.ts`](../shared/src/index.ts) — `ZfsState`/`ZfsPool`/
  `ZfsVdev`/`ZfsDevice`/`ZfsDataset`/`ZfsSnapshot`/`ZfsBlockDevice`, new
  `CentralApiOperations` entries.
- [`shared/src/tasks.ts`](../shared/src/tasks.ts) — `zfs_*` `TaskSpec`/
  `TaskResult` variants.
- New `apps/server/src/features/zfs/zfs.ts` — parsing + command-building, same shape as
  [`docker.ts`](../apps/server/src/features/docker/docker.ts)/[`systemd.ts`](../apps/server/src/features/systemd/systemd.ts).
- [`apps/server/src/features/zfs/feature.ts`](../apps/server/src/features/zfs/feature.ts) — op wiring,
  task-kind handlers, owner-only gating.
- Web — new ZFS tab, pool detail, create-pool wizard, dataset/snapshot
  tables and forms.
