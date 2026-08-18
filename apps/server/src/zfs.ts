import type {
    ZfsBlockDevice,
    ZfsDataset,
    ZfsDevice,
    ZfsHealth,
    ZfsPool,
    ZfsScanStatus,
    ZfsSnapshot,
    ZfsState,
    ZfsVdev,
    ZfsVdevType,
} from "@central/shared";
import type { HostAgent } from "./host-agent";

// Pool/dataset/snapshot names — ZoL is lenient enough to allow spaces in a name
// (seen in the wild, e.g. a TrueNAS pool named "sata ssds"), so this can't be as
// strict as docker.ts's SAFE_ID_RE. It still excludes every shell metacharacter;
// every use below wraps the value in double quotes on top of this check.
const SAFE_NAME_RE = /^[A-Za-z0-9 _.:/-]+$/;
const SAFE_SNAPSHOT_RE = /^[A-Za-z0-9 _.:/-]+@[A-Za-z0-9 _.:-]+$/;
const SAFE_PROP_KEY_RE = /^[A-Za-z0-9_:.-]+$/;
const SAFE_PROP_VALUE_RE = /^[A-Za-z0-9_./:%-]+$/;
/** A device *reference* as zpool status prints it: a `/dev/...` path, a bare
 *  disk/by-id name, or a partition GUID. Permissive — this identifies an
 *  *existing* pool member, not something the caller free-types. */
const SAFE_DEVICE_REF_RE = /^[A-Za-z0-9_.:/-]+$/;
/** A *new* device being added to a pool — must be a `/dev/...` path (by-id,
 *  per the safety model in doc/idea_zfs.md — never bare `/dev/sdX`). */
const SAFE_NEW_DEVICE_RE = /^\/dev\/[A-Za-z0-9_./-]+$/;

function assertName(name: string, label = "name"): void {
    if (!name || !SAFE_NAME_RE.test(name)) {
        throw new Error(`Invalid ZFS ${label}: ${JSON.stringify(name)}`);
    }
}

function assertSnapshotName(name: string): void {
    if (!name || !SAFE_SNAPSHOT_RE.test(name)) {
        throw new Error(`Invalid ZFS snapshot name: ${JSON.stringify(name)}`);
    }
}

function assertPropKey(key: string): void {
    if (!key || !SAFE_PROP_KEY_RE.test(key)) {
        throw new Error(`Invalid ZFS property name: ${JSON.stringify(key)}`);
    }
}

function assertPropValue(value: string): void {
    if (!SAFE_PROP_VALUE_RE.test(value)) {
        throw new Error(`Invalid ZFS property value: ${JSON.stringify(value)}`);
    }
}

function assertDeviceRef(device: string): void {
    if (!device || !SAFE_DEVICE_REF_RE.test(device)) {
        throw new Error(`Invalid device reference: ${JSON.stringify(device)}`);
    }
}

function assertNewDevice(device: string): void {
    if (!device || !SAFE_NEW_DEVICE_RE.test(device)) {
        throw new Error(`New pool devices must be a /dev/disk/by-id path, got: ${JSON.stringify(device)}`);
    }
}

/** Double-quote a value already validated against one of the SAFE_*_RE above
 *  (none of which permit `"`, so no escaping is needed on top of the quotes). */
function q(value: string): string {
    return `"${value}"`;
}

function firstErrorLine(res: { stdout: string; stderr: string }): string {
    return (res.stdout + res.stderr).trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
}

async function runOrThrow(server: HostAgent, command: string, onLog?: (text: string, stream?: "stdout" | "stderr") => void): Promise<void> {
    const res = await server.exec(command);
    if (res.stdout) {
        onLog?.(res.stdout, "stdout");
    }
    if (res.stderr) {
        onLog?.(res.stderr, "stderr");
    }
    if (res.code !== 0) {
        throw new Error(firstErrorLine(res) || `Command failed: ${command}`);
    }
}

function toNumber(field: string | undefined): number {
    const n = Number(field);
    return Number.isFinite(n) ? n : 0;
}

/** "-" / "none" / "" all mean "unset" across zfs/zpool's `-p` output. */
function nullableField(field: string | undefined): string | null {
    return field && field !== "-" && field !== "none" ? field : null;
}

// ---- `zpool list` — sizes/capacity/health, one line per pool -----------------

interface PoolListRow {
    name: string;
    sizeBytes: number;
    allocatedBytes: number;
    freeBytes: number;
    fragmentationPct: number;
    capacityPct: number;
    state: ZfsHealth;
}

function parsePoolList(stdout: string): PoolListRow[] {
    const rows: PoolListRow[] = [];
    for (const line of stdout.split("\n")) {
        if (!line.trim()) {
            continue;
        }
        const f = line.split("\t");
        if (f.length < 7) {
            continue;
        }
        rows.push({
            name: f[0],
            sizeBytes: toNumber(f[1]),
            allocatedBytes: toNumber(f[2]),
            freeBytes: toNumber(f[3]),
            // "-" when fragmentation isn't tracked (e.g. mid-upgrade pools).
            fragmentationPct: f[4] === "-" ? 0 : toNumber(f[4]),
            capacityPct: toNumber(f[5]),
            state: (f[6] as ZfsHealth) || "UNAVAIL",
        });
    }
    return rows;
}

// ---- `zpool status` — health, vdev tree, scan, errors, per pool --------------

const VDEV_TYPE_RE = /^(mirror|raidz[123]|draid[123]?)-\d+$/;
// Section labels that introduce a group of devices without being a vdev
// themselves (`zpool status`'s tree prints these as bare words).
const SECTION_LABELS: Record<string, ZfsVdevType> = { logs: "log", cache: "cache", spares: "spare" };

/** Matches a config-tree row's trailing `STATE READ WRITE CKSUM` columns,
 *  wherever the name ends — works even when the name itself contains spaces
 *  (real pool names can), since the state token is drawn from a closed enum. */
const TREE_ROW_RE = /^(.+?)\s+(ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED|AVAIL|INUSE)\s+(-|\d+)\s+(-|\d+)\s+(-|\d+)\s*$/;

interface PoolStatusInfo {
    state: ZfsHealth;
    errors: string;
    scan: ZfsScanStatus | null;
    vdevs: ZfsVdev[];
    /** Every device identifier this pool's tree mentions (GUID, by-id name, or
     *  bare disk name, how ever zpool printed it) — used to cross-reference
     *  block devices as in-use. */
    deviceRefs: string[];
}

function indentOf(line: string): number {
    let n = 0;
    for (const c of line) {
        if (c === " " || c === "\t") {
            n++;
        } else {
            break;
        }
    }
    return n;
}

function parseScan(scanLines: string[]): ZfsScanStatus | null {
    const text = scanLines.join(" ").replace(/\s+/g, " ").trim();
    if (!text || /^none/i.test(text)) {
        return null;
    }
    const kind: ZfsScanStatus["kind"] = /resilver/i.test(text) ? "resilver" : "scrub";

    if (/in progress/i.test(text)) {
        const since = text.match(/since (\w{3} \w{3}\s+\d+ [\d:]+ \d{4})/);
        const pct = text.match(/([\d.]+)%\s*done/i);
        const eta = text.match(/([\d :a-z]+?)\s+to go/i);
        const startedAt = since ? Date.parse(since[1]) : Date.now();
        return {
            kind,
            state: "in_progress",
            startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
            pctDone: pct ? Number(pct[1]) : undefined,
            eta: eta ? eta[1].trim() : undefined,
        };
    }

    const on = text.match(/on (\w{3} \w{3}\s+\d+ [\d:]+ \d{4})/);
    const finishedAt = on ? Date.parse(on[1]) : Date.now();
    const state: ZfsScanStatus["state"] = /cancel/i.test(text) ? "cancelled" : "completed";
    return {
        kind,
        state,
        startedAt: Number.isFinite(finishedAt) ? finishedAt : Date.now(),
        finishedAt: Number.isFinite(finishedAt) ? finishedAt : undefined,
    };
}

function parsePoolStatus(stdout: string): Map<string, PoolStatusInfo> {
    const out = new Map<string, PoolStatusInfo>();
    const lines = stdout.split("\n");

    let name: string | null = null;
    let state: ZfsHealth = "UNAVAIL";
    let errors = "";
    let scanLines: string[] = [];
    let inScan = false;
    let inConfig = false;
    let inErrors = false;
    // Stack of { indent, vdev } for the tree currently being built; a config
    // row attaches as a child of the nearest entry with a smaller indent.
    let vdevs: ZfsVdev[] = [];
    let deviceRefs: string[] = [];
    let stack: { indent: number; devices: ZfsDevice[] }[] = [];
    let sectionType: ZfsVdevType | null = null;

    function flush() {
        if (name) {
            out.set(name, { state, errors: errors.trim() || "No known data errors", scan: parseScan(scanLines), vdevs, deviceRefs });
        }
        name = null;
        state = "UNAVAIL";
        errors = "";
        scanLines = [];
        inScan = false;
        inConfig = false;
        inErrors = false;
        vdevs = [];
        deviceRefs = [];
        stack = [];
        sectionType = null;
    }

    for (const raw of lines) {
        const trimmed = raw.trim();
        const poolMatch = trimmed.match(/^pool:\s*(.+)$/);
        if (poolMatch) {
            flush();
            name = poolMatch[1];
            continue;
        }
        if (name === null) {
            continue;
        }
        const stateMatch = trimmed.match(/^state:\s*(.+)$/);
        if (stateMatch) {
            state = (stateMatch[1].trim() as ZfsHealth) || "UNAVAIL";
            inScan = false;
            inConfig = false;
            inErrors = false;
            continue;
        }
        if (/^scan:/.test(trimmed)) {
            scanLines = [trimmed.replace(/^scan:\s*/, "")];
            inScan = true;
            inConfig = false;
            inErrors = false;
            continue;
        }
        if (/^config:/.test(trimmed)) {
            inScan = false;
            inConfig = true;
            inErrors = false;
            continue;
        }
        if (/^errors:\s*/.test(trimmed)) {
            errors = trimmed.replace(/^errors:\s*/, "");
            inScan = false;
            inConfig = false;
            inErrors = true;
            continue;
        }
        // Any other top-level label (status:/action:/see:) ends whatever
        // section we were in — its wrapped continuation lines are indented
        // and otherwise unlabeled, so bail out of scan/config on them too.
        if (/^[a-z]+:/.test(trimmed) && !inConfig) {
            inScan = false;
            inErrors = false;
            continue;
        }

        if (inScan) {
            if (trimmed) {
                scanLines.push(trimmed);
            }
            continue;
        }
        if (inErrors) {
            if (trimmed) {
                errors += ` ${trimmed}`;
            }
            continue;
        }
        if (!inConfig || !trimmed) {
            continue;
        }
        if (/^NAME\s+STATE\s+READ/.test(trimmed)) {
            continue; // header row
        }

        const rowMatch = raw.match(TREE_ROW_RE);
        const indent = indentOf(raw);
        if (!rowMatch) {
            // A bare section label (logs/cache/spares) — no status columns.
            const label = SECTION_LABELS[trimmed.toLowerCase()];
            if (label) {
                sectionType = label;
                stack = [{ indent, devices: [] }];
            }
            continue;
        }

        const [, rawLabel, devState, rd, wr, ck] = rowMatch;
        const label = rawLabel.trim();
        while (stack.length && stack[stack.length - 1].indent >= indent) {
            stack.pop();
        }

        if (label === name) {
            // The pool-root row — not a vdev by itself, just establishes depth 0.
            stack = [{ indent, devices: [] }];
            continue;
        }

        const vdevType = VDEV_TYPE_RE.exec(label)?.[1] as ZfsVdevType | undefined;
        if (stack.length <= 1 && (vdevType || sectionType)) {
            // A named vdev group (mirror-0, raidz1-0, …) directly under the pool.
            const devices: ZfsDevice[] = [];
            vdevs.push({ type: vdevType ?? sectionType ?? "stripe", state: devState as ZfsHealth, devices });
            stack.push({ indent, devices });
            continue;
        }

        // A device: either nested under a vdev group, or (bare stripe member)
        // sitting directly under the pool root with no group line at all.
        const device: ZfsDevice = {
            name: label,
            type: "disk",
            state: devState as ZfsHealth,
            readErrors: rd === "-" ? 0 : Number(rd),
            writeErrors: wr === "-" ? 0 : Number(wr),
            checksumErrors: ck === "-" ? 0 : Number(ck),
        };
        deviceRefs.push(label);
        if (stack.length > 1) {
            stack[stack.length - 1].devices.push(device);
        } else {
            // No vdev group above this — it's its own single-device stripe vdev.
            vdevs.push({ type: "stripe", state: devState as ZfsHealth, devices: [device] });
            stack.push({ indent, devices: [device] });
        }
    }
    flush();
    return out;
}

export async function zfsGetState(server: HostAgent): Promise<ZfsState> {
    const probe = await server.exec("zpool version 2>&1");
    if (probe.code !== 0) {
        return { available: false, error: firstErrorLine(probe) || "ZFS is not available on this host", pools: [] };
    }

    const [listRes, statusRes] = await Promise.all([
        server.exec("zpool list -H -p -o name,size,alloc,free,fragmentation,capacity,health 2>&1"),
        server.exec("zpool status 2>&1"),
    ]);
    if (listRes.code !== 0) {
        return { available: false, error: firstErrorLine(listRes) || "zpool list failed", pools: [] };
    }

    const summaries = parsePoolList(listRes.stdout);
    const details = parsePoolStatus(statusRes.stdout);
    const pools: ZfsPool[] = summaries.map((s) => {
        const d = details.get(s.name);
        return {
            name: s.name,
            state: d?.state ?? s.state,
            sizeBytes: s.sizeBytes,
            allocatedBytes: s.allocatedBytes,
            freeBytes: s.freeBytes,
            fragmentationPct: s.fragmentationPct,
            capacityPct: s.capacityPct,
            errors: d?.errors ?? "",
            scan: d?.scan ?? null,
            vdevs: d?.vdevs ?? [],
        };
    });
    return { available: true, pools };
}

/** For the block-device in-use cross-check: every device identifier every
 *  pool's tree mentions, keyed by pool name. Re-runs `zpool status` — cheap,
 *  and keeps this independent of {@link zfsGetState}'s call shape. */
async function zfsGetPoolDeviceRefs(server: HostAgent): Promise<Map<string, { pool: string }>> {
    const res = await server.exec("zpool status 2>&1");
    const details = parsePoolStatus(res.stdout);
    const map = new Map<string, { pool: string }>();
    for (const [pool, info] of details) {
        for (const ref of info.deviceRefs) {
            map.set(ref, { pool });
        }
    }
    return map;
}

// ---- Datasets ------------------------------------------------------------------

const DATASET_FIELDS = "name,used,avail,refer,mountpoint,compression,compressratio,quota,recordsize,volsize,origin,mounted,canmount,type";

export async function zfsGetDatasets(server: HostAgent, pool?: string): Promise<ZfsDataset[]> {
    if (pool) {
        assertName(pool, "pool");
    }
    const scope = pool ? `-r ${q(pool)}` : "";
    const res = await server.exec(`zfs list -H -p -t filesystem,volume -o ${DATASET_FIELDS} ${scope} 2>&1`);
    if (res.code !== 0) {
        throw new Error(firstErrorLine(res) || "zfs list failed");
    }
    const out: ZfsDataset[] = [];
    for (const line of res.stdout.split("\n")) {
        if (!line.trim()) {
            continue;
        }
        const f = line.split("\t");
        if (f.length < 14) {
            continue;
        }
        const [nm, used, avail, refer, mountpoint, compression, compressratio, quota, recordsize, volsize, origin, mounted, canmount, type] = f;
        const slash = nm.indexOf("/");
        out.push({
            name: nm,
            pool: slash === -1 ? nm : nm.slice(0, slash),
            type: type === "volume" ? "volume" : "filesystem",
            usedBytes: toNumber(used),
            availBytes: toNumber(avail),
            referBytes: toNumber(refer),
            mountpoint: nullableField(mountpoint),
            mounted: mounted === "yes",
            canmount: canmount === "off" || canmount === "noauto" ? canmount : "on",
            compression,
            compressRatio: Number.parseFloat(compressratio) || 1,
            quotaBytes: quota && quota !== "0" ? toNumber(quota) : null,
            recordsize: recordsize && recordsize !== "-" ? toNumber(recordsize) : undefined,
            volsizeBytes: volsize && volsize !== "-" ? toNumber(volsize) : undefined,
            origin: nullableField(origin) ?? undefined,
        });
    }
    return out;
}

export async function setDatasetProperty(server: HostAgent, name: string, key: string, value: string): Promise<void> {
    assertName(name, "dataset");
    assertPropKey(key);
    assertPropValue(value);
    await runOrThrow(server, `zfs set ${key}=${value} ${q(name)} 2>&1`);
}

// ---- Snapshots -------------------------------------------------------------------

export async function zfsGetSnapshots(server: HostAgent, dataset?: string): Promise<ZfsSnapshot[]> {
    if (dataset) {
        assertName(dataset, "dataset");
    }
    const scope = dataset ? `-r ${q(dataset)}` : "";
    const res = await server.exec(`zfs list -H -p -t snapshot -o name,used,refer,creation ${scope} 2>&1`);
    if (res.code !== 0) {
        // No snapshots at all isn't an error condition worth surfacing.
        if (/no datasets available|dataset does not exist/i.test(res.stdout + res.stderr)) {
            return [];
        }
        throw new Error(firstErrorLine(res) || "zfs list failed");
    }
    const out: ZfsSnapshot[] = [];
    for (const line of res.stdout.split("\n")) {
        if (!line.trim()) {
            continue;
        }
        const f = line.split("\t");
        if (f.length < 4) {
            continue;
        }
        const [nm, used, refer, creation] = f;
        const at = nm.indexOf("@");
        out.push({
            name: nm,
            dataset: at === -1 ? nm : nm.slice(0, at),
            createdAt: toNumber(creation) * 1000,
            usedBytes: toNumber(used),
            referBytes: toNumber(refer),
        });
    }
    return out;
}

export async function zfsSnapshotCreate(server: HostAgent, dataset: string, name: string, recursive: boolean, onLog?: (t: string, s?: "stdout" | "stderr") => void): Promise<void> {
    assertName(dataset, "dataset");
    assertName(name, "snapshot name");
    const full = `${dataset}@${name}`;
    assertSnapshotName(full);
    await runOrThrow(server, `zfs snapshot ${recursive ? "-r " : ""}${q(full)} 2>&1`, onLog);
}

export async function zfsSnapshotDestroy(server: HostAgent, snapshot: string, onLog?: (t: string, s?: "stdout" | "stderr") => void): Promise<void> {
    assertSnapshotName(snapshot);
    await runOrThrow(server, `zfs destroy ${q(snapshot)} 2>&1`, onLog);
}

/** No `-f` — ever (see doc/idea_zfs.md's safety model). `destroyLater` maps to
 *  `-r`, which destroys snapshots newer than the target; the UI must show that
 *  count to the operator before setting it, not bury it in a checkbox. */
export async function zfsSnapshotRollback(server: HostAgent, snapshot: string, destroyLater: boolean, onLog?: (t: string, s?: "stdout" | "stderr") => void): Promise<void> {
    assertSnapshotName(snapshot);
    await runOrThrow(server, `zfs rollback ${destroyLater ? "-r " : ""}${q(snapshot)} 2>&1`, onLog);
}

export async function zfsSnapshotClone(server: HostAgent, snapshot: string, target: string, onLog?: (t: string, s?: "stdout" | "stderr") => void): Promise<void> {
    assertSnapshotName(snapshot);
    assertName(target, "clone target");
    await runOrThrow(server, `zfs clone ${q(snapshot)} ${q(target)} 2>&1`, onLog);
}

// ---- Dataset lifecycle -------------------------------------------------------------

export async function zfsDatasetCreate(
    server: HostAgent,
    parent: string,
    name: string,
    type: "filesystem" | "volume",
    volsizeBytes: number | undefined,
    properties: Record<string, string> | undefined,
    onLog?: (t: string, s?: "stdout" | "stderr") => void,
): Promise<void> {
    assertName(parent, "parent dataset");
    assertName(name, "dataset name");
    const full = `${parent}/${name}`;
    assertName(full, "dataset name");
    if (type === "volume" && (!volsizeBytes || volsizeBytes <= 0)) {
        throw new Error("A zvol needs a volume size");
    }
    const propFlags: string[] = [];
    for (const [key, value] of Object.entries(properties ?? {})) {
        assertPropKey(key);
        assertPropValue(value);
        propFlags.push(`-o ${key}=${value}`);
    }
    const sizeFlag = type === "volume" ? `-V ${Math.floor(volsizeBytes!)} ` : "";
    await runOrThrow(server, `zfs create ${sizeFlag}${propFlags.join(" ")} ${q(full)} 2>&1`, onLog);
}

export async function zfsDatasetDestroy(server: HostAgent, name: string, recursive: boolean, onLog?: (t: string, s?: "stdout" | "stderr") => void): Promise<void> {
    assertName(name, "dataset");
    await runOrThrow(server, `zfs destroy ${recursive ? "-r " : ""}${q(name)} 2>&1`, onLog);
}

// ---- Block devices (for the pool/vdev disk picker) --------------------------------

interface LsblkRow {
    NAME: string;
    TYPE: string;
    SIZE: string;
    MODEL: string;
    SERIAL: string;
    ROTA: string;
    MOUNTPOINT: string;
    FSTYPE: string;
    PKNAME: string;
    PARTUUID: string;
}

function parseLsblkPairs(stdout: string): LsblkRow[] {
    const rows: LsblkRow[] = [];
    for (const line of stdout.split("\n")) {
        if (!line.trim()) {
            continue;
        }
        const fields: Record<string, string> = {};
        const re = /(\w+)="([^"]*)"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line))) {
            fields[m[1]] = m[2];
        }
        if (fields.NAME) {
            rows.push(fields as unknown as LsblkRow);
        }
    }
    return rows;
}

export async function zfsGetBlockDevices(server: HostAgent): Promise<ZfsBlockDevice[]> {
    const [lsblkRes, byIdRes, refs] = await Promise.all([
        server.exec("lsblk -b -P -o NAME,TYPE,SIZE,MODEL,SERIAL,ROTA,MOUNTPOINT,FSTYPE,PKNAME,PARTUUID 2>&1"),
        server.exec(`for f in /dev/disk/by-id/*; do echo "$f $(readlink -f "$f")"; done 2>/dev/null`),
        zfsGetPoolDeviceRefs(server),
    ]);
    if (lsblkRes.code !== 0) {
        throw new Error(firstErrorLine(lsblkRes) || "lsblk failed");
    }

    const byIdByDevPath = new Map<string, string[]>();
    for (const line of byIdRes.stdout.split("\n")) {
        const sp = line.indexOf(" ");
        if (sp === -1) {
            continue;
        }
        const byId = line.slice(0, sp);
        const resolved = line.slice(sp + 1).trim();
        const list = byIdByDevPath.get(resolved) ?? [];
        list.push(byId);
        byIdByDevPath.set(resolved, list);
    }

    const rows = parseLsblkPairs(lsblkRes.stdout);
    const disks = rows.filter((r) => r.TYPE === "disk");
    const children = (diskName: string) => rows.filter((r) => r.PKNAME === diskName);

    const out: ZfsBlockDevice[] = [];
    for (const disk of disks) {
        const devPath = `/dev/${disk.NAME}`;
        const byIdPaths = byIdByDevPath.get(devPath) ?? [];
        const kids = children(disk.NAME);
        const parts = [disk, ...kids];

        let inUse: ZfsBlockDevice["inUse"] = null;
        let inUseDetail: string | undefined;

        // ZFS in-use: this disk's own PARTUUID/name, or any child partition's
        // PARTUUID, matches a device identifier zpool status printed.
        for (const part of parts) {
            const candidates = [part.NAME, part.PARTUUID, ...(byIdByDevPath.get(`/dev/${part.NAME}`) ?? []).map((p) => p.replace("/dev/disk/by-id/", ""))];
            for (const c of candidates) {
                const hit = c && refs.get(c);
                if (hit) {
                    inUse = "zfs";
                    inUseDetail = `pool "${hit.pool}"`;
                    break;
                }
            }
            if (inUse) {
                break;
            }
        }
        if (!inUse) {
            const mountedOn = parts.find((p) => p.MOUNTPOINT)?.MOUNTPOINT;
            if (mountedOn) {
                inUse = "mounted";
                inUseDetail = mountedOn;
            } else if (kids.length > 0 || disk.FSTYPE) {
                inUse = "partitioned";
                const fstypes = [...new Set(parts.map((p) => p.FSTYPE).filter(Boolean))];
                inUseDetail = fstypes.length ? fstypes.join(", ") : "has a partition table";
            }
        }

        out.push({
            name: disk.NAME,
            byIdPaths,
            sizeBytes: toNumber(disk.SIZE),
            model: disk.MODEL,
            serial: disk.SERIAL,
            rotational: disk.ROTA === "1",
            inUse,
            inUseDetail,
        });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Pool lifecycle (owner-gated in handler.ts) -----------------------------------

function vdevArgs(vdevs: { type: ZfsVdevType; devices: string[] }[]): string {
    return vdevs
        .map((v) => {
            if (v.devices.length === 0) {
                throw new Error(`A ${v.type} vdev needs at least one device`);
            }
            for (const d of v.devices) {
                assertNewDevice(d);
            }
            const devs = v.devices.map(q).join(" ");
            return v.type === "stripe" ? devs : `${v.type} ${devs}`;
        })
        .join(" ");
}

export async function zfsPoolCreate(server: HostAgent, name: string, vdevs: { type: ZfsVdevType; devices: string[] }[], force?: boolean, onLog?: (t: string, s?: "stdout" | "stderr") => void): Promise<void> {
    assertName(name, "pool name");
    if (vdevs.length === 0) {
        throw new Error("Pick at least one vdev");
    }
    await runOrThrow(server, `zpool create ${force ? "-f " : ""}${q(name)} ${vdevArgs(vdevs)} 2>&1`, onLog);
}

export async function zfsPoolDestroy(server: HostAgent, name: string, onLog?: (t: string, s?: "stdout" | "stderr") => void): Promise<void> {
    assertName(name, "pool name");
    await runOrThrow(server, `zpool destroy ${q(name)} 2>&1`, onLog);
}

export async function zfsPoolImport(server: HostAgent, name: string, onLog?: (t: string, s?: "stdout" | "stderr") => void): Promise<void> {
    assertName(name, "pool name");
    await runOrThrow(server, `zpool import ${q(name)} 2>&1`, onLog);
}

export async function zfsPoolExport(server: HostAgent, name: string, onLog?: (t: string, s?: "stdout" | "stderr") => void): Promise<void> {
    assertName(name, "pool name");
    await runOrThrow(server, `zpool export ${q(name)} 2>&1`, onLog);
}

export async function zfsVdevAdd(server: HostAgent, pool: string, vdev: { type: ZfsVdevType; devices: string[] }, force?: boolean, onLog?: (t: string, s?: "stdout" | "stderr") => void): Promise<void> {
    assertName(pool, "pool name");
    await runOrThrow(server, `zpool add ${force ? "-f " : ""}${q(pool)} ${vdevArgs([vdev])} 2>&1`, onLog);
}

export async function zfsDeviceReplace(server: HostAgent, pool: string, oldDevice: string, newDevice: string, onLog?: (t: string, s?: "stdout" | "stderr") => void): Promise<void> {
    assertName(pool, "pool name");
    assertDeviceRef(oldDevice);
    assertNewDevice(newDevice);
    await runOrThrow(server, `zpool replace ${q(pool)} ${q(oldDevice)} ${q(newDevice)} 2>&1`, onLog);
}

export async function zfsScrub(server: HostAgent, pool: string, action: "start" | "stop", onLog?: (t: string, s?: "stdout" | "stderr") => void): Promise<void> {
    assertName(pool, "pool name");
    await runOrThrow(server, `zpool scrub ${action === "stop" ? "-s " : ""}${q(pool)} 2>&1`, onLog);
}
