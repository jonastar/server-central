import type {
    HostCapabilityResult,
    TaskZfsDatasetCreate,
    TaskZfsDatasetCreateResult,
    TaskZfsDatasetDestroy,
    TaskZfsDatasetDestroyResult,
    TaskZfsDeviceReplace,
    TaskZfsDeviceReplaceResult,
    TaskZfsPoolCreate,
    TaskZfsPoolCreateResult,
    TaskZfsPoolDestroy,
    TaskZfsPoolDestroyResult,
    TaskZfsPoolExport,
    TaskZfsPoolExportResult,
    TaskZfsPoolImport,
    TaskZfsPoolImportResult,
    TaskZfsScrub,
    TaskZfsScrubResult,
    TaskZfsSnapshotClone,
    TaskZfsSnapshotCloneResult,
    TaskZfsSnapshotCreate,
    TaskZfsSnapshotCreateResult,
    TaskZfsSnapshotDestroy,
    TaskZfsSnapshotDestroyResult,
    TaskZfsSnapshotRollback,
    TaskZfsSnapshotRollbackResult,
    TaskZfsVdevAdd,
    TaskZfsVdevAddResult,
    ZfsBlockDevice,
    ZfsDataset,
    ZfsSnapshot,
    ZfsState,
} from "@central/shared";
import type { AgentFeature, Feature, FeatureApiHandlers, FeatureTaskHandlers } from "../../feature";
import type { Fleet } from "../../fleet";
import { requireAgent, type TaskCtx } from "../../tasks/types";
import {
    setDatasetProperty,
    zfsDatasetCreate,
    zfsDatasetDestroy,
    zfsDeviceReplace,
    zfsGetBlockDevices,
    zfsGetDatasets,
    zfsGetSnapshots,
    zfsGetState,
    zfsPoolCreate,
    zfsPoolDestroy,
    zfsPoolExport,
    zfsPoolImport,
    zfsScrub,
    zfsSnapshotClone,
    zfsSnapshotCreate,
    zfsSnapshotDestroy,
    zfsSnapshotRollback,
    zfsVdevAdd,
} from "./zfs";
import * as os from "node:os";
import { accessible, constants, exists, which } from "../../agent/probe-utils";

export function createZfsFeature(fleet: Fleet): Feature<ZfsOps, ZfsTaskKind> {
    return {
        descriptor: {
            id: "zfs",
            name: "ZFS",
            description: "ZFS pool/dataset/snapshot management on a host. See doc/idea_zfs.md.",
            experimental: false,
            requiresHostCapability: "zfs",
        },
        apiHandlers() {
            return zfsApiHandlers(fleet);
        },
        taskHandlers() {
            return zfsTaskHandlers();
        },
        ownerOnlyTaskKinds: ZFS_OWNER_ONLY_TASK_KINDS,
    };
}

export type ZfsOps = "getZfsState" | "getZfsDatasets" | "getZfsSnapshots" | "getZfsBlockDevices" | "setDatasetProperty";

/** ZFS pool/vdev topology mutations — the highest blast-radius task kinds —
 *  are owner-only (see doc/idea_zfs.md's safety model). Dataset/snapshot
 *  mutations aren't gated, consistent with the rest of the task system today
 *  (docker/systemd actions aren't role-gated either). Declared on the feature
 *  above, which is what `runTask` enforces against. */
const ZFS_OWNER_ONLY_TASK_KINDS = [
    "zfs_pool_create",
    "zfs_pool_destroy",
    "zfs_pool_import",
    "zfs_pool_export",
    "zfs_vdev_add",
    "zfs_device_replace",
] as const satisfies readonly ZfsTaskKind[];

export function zfsApiHandlers(fleet: Fleet): FeatureApiHandlers<ZfsOps> {
    return {
        async handleGetZfsState(data: { serverId: string }): Promise<ZfsState> {
            return zfsGetState(fleet.get(data.serverId));
        },

        async handleGetZfsDatasets(data: { serverId: string; pool?: string }): Promise<ZfsDataset[]> {
            return zfsGetDatasets(fleet.get(data.serverId), data.pool);
        },

        async handleGetZfsSnapshots(data: { serverId: string; dataset?: string }): Promise<ZfsSnapshot[]> {
            return zfsGetSnapshots(fleet.get(data.serverId), data.dataset);
        },

        async handleGetZfsBlockDevices(data: { serverId: string }): Promise<ZfsBlockDevice[]> {
            return zfsGetBlockDevices(fleet.get(data.serverId));
        },

        async handleSetDatasetProperty(data: { serverId: string; name: string; key: string; value: string }): Promise<void> {
            await setDatasetProperty(fleet.get(data.serverId), data.name, data.key, data.value);
        },
    };
}

type ZfsTaskKind = "zfs_pool_create" | "zfs_pool_destroy" | "zfs_pool_import" | "zfs_pool_export"
    | "zfs_vdev_add" | "zfs_device_replace" | "zfs_scrub" | "zfs_dataset_create" | "zfs_dataset_destroy"
    | "zfs_snapshot_create" | "zfs_snapshot_rollback" | "zfs_snapshot_destroy" | "zfs_snapshot_clone";

export function zfsTaskHandlers(): FeatureTaskHandlers<ZfsTaskKind> {
    return {
        async zfs_pool_create(spec: TaskZfsPoolCreate, ctx: TaskCtx): Promise<TaskZfsPoolCreateResult> {
            await zfsPoolCreate(requireAgent(ctx, "zfs_pool_create"), spec.name, spec.vdevs, spec.force, ctx.log);
            return { kind: "zfs_pool_create" };
        },

        async zfs_pool_destroy(spec: TaskZfsPoolDestroy, ctx: TaskCtx): Promise<TaskZfsPoolDestroyResult> {
            await zfsPoolDestroy(requireAgent(ctx, "zfs_pool_destroy"), spec.name, ctx.log);
            return { kind: "zfs_pool_destroy" };
        },

        async zfs_pool_import(spec: TaskZfsPoolImport, ctx: TaskCtx): Promise<TaskZfsPoolImportResult> {
            await zfsPoolImport(requireAgent(ctx, "zfs_pool_import"), spec.name, ctx.log);
            return { kind: "zfs_pool_import" };
        },

        async zfs_pool_export(spec: TaskZfsPoolExport, ctx: TaskCtx): Promise<TaskZfsPoolExportResult> {
            await zfsPoolExport(requireAgent(ctx, "zfs_pool_export"), spec.name, ctx.log);
            return { kind: "zfs_pool_export" };
        },

        async zfs_vdev_add(spec: TaskZfsVdevAdd, ctx: TaskCtx): Promise<TaskZfsVdevAddResult> {
            await zfsVdevAdd(requireAgent(ctx, "zfs_vdev_add"), spec.pool, spec.vdev, spec.force, ctx.log);
            return { kind: "zfs_vdev_add" };
        },

        async zfs_device_replace(spec: TaskZfsDeviceReplace, ctx: TaskCtx): Promise<TaskZfsDeviceReplaceResult> {
            await zfsDeviceReplace(requireAgent(ctx, "zfs_device_replace"), spec.pool, spec.oldDevice, spec.newDevice, ctx.log);
            return { kind: "zfs_device_replace" };
        },

        async zfs_scrub(spec: TaskZfsScrub, ctx: TaskCtx): Promise<TaskZfsScrubResult> {
            await zfsScrub(requireAgent(ctx, "zfs_scrub"), spec.pool, spec.action, ctx.log);
            return { kind: "zfs_scrub" };
        },

        async zfs_dataset_create(spec: TaskZfsDatasetCreate, ctx: TaskCtx): Promise<TaskZfsDatasetCreateResult> {
            await zfsDatasetCreate(requireAgent(ctx, "zfs_dataset_create"), spec.parent, spec.name, spec.type, spec.volsizeBytes, spec.properties, ctx.log);
            return { kind: "zfs_dataset_create" };
        },

        async zfs_dataset_destroy(spec: TaskZfsDatasetDestroy, ctx: TaskCtx): Promise<TaskZfsDatasetDestroyResult> {
            await zfsDatasetDestroy(requireAgent(ctx, "zfs_dataset_destroy"), spec.name, spec.recursive, ctx.log);
            return { kind: "zfs_dataset_destroy" };
        },

        async zfs_snapshot_create(spec: TaskZfsSnapshotCreate, ctx: TaskCtx): Promise<TaskZfsSnapshotCreateResult> {
            await zfsSnapshotCreate(requireAgent(ctx, "zfs_snapshot_create"), spec.dataset, spec.name, spec.recursive, ctx.log);
            return { kind: "zfs_snapshot_create" };
        },

        async zfs_snapshot_rollback(spec: TaskZfsSnapshotRollback, ctx: TaskCtx): Promise<TaskZfsSnapshotRollbackResult> {
            await zfsSnapshotRollback(requireAgent(ctx, "zfs_snapshot_rollback"), spec.snapshot, spec.destroyLater, ctx.log);
            return { kind: "zfs_snapshot_rollback" };
        },

        async zfs_snapshot_destroy(spec: TaskZfsSnapshotDestroy, ctx: TaskCtx): Promise<TaskZfsSnapshotDestroyResult> {
            await zfsSnapshotDestroy(requireAgent(ctx, "zfs_snapshot_destroy"), spec.snapshot, ctx.log);
            return { kind: "zfs_snapshot_destroy" };
        },

        async zfs_snapshot_clone(spec: TaskZfsSnapshotClone, ctx: TaskCtx): Promise<TaskZfsSnapshotCloneResult> {
            await zfsSnapshotClone(requireAgent(ctx, "zfs_snapshot_clone"), spec.snapshot, spec.target, ctx.log);
            return { kind: "zfs_snapshot_clone" };
        },
    };
}

/**
 * ZFS needs both halves: the userland tools *and* a loaded kernel module. They
 * install independently, and on a kernel that never loaded the module `zpool` is
 * present while every command fails — so probing the binary alone is exactly the
 * false positive this exists to avoid. `/dev/zfs` is the character device the
 * tools talk to; its presence is what "loaded and usable" actually means.
 */
export function zfsAgentFeature(): AgentFeature {
    return {
        id: "zfs",
        hostProbe: {
            capability: "zfs",
            async probe(): Promise<HostCapabilityResult> {
                if (!await which("zpool")) {
                    return { available: false, detail: "The zpool/zfs tools aren't installed on this host (try the zfsutils-linux package)." };
                }
                if (!await exists("/dev/zfs")) {
                    return { available: false, detail: "ZFS tools are installed but the kernel module isn't loaded — try `modprobe zfs`." };
                }
                if (!await accessible("/dev/zfs", constants.R_OK | constants.W_OK)) {
                    return { available: false, detail: `ZFS is present but the agent (uid ${os.userInfo().uid}) can't open /dev/zfs — it needs to run as root.` };
                }
                return { available: true };
            },
        },
    };
}
