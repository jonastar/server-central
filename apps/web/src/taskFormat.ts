import type { ServerEntry, TaskRun, TaskSpec, TaskStatus } from "@central/shared";

/** Shared formatting for task runs — used by TasksView, TaskModal, and TaskWidget
 *  so a new task kind only needs its `specSummary`/`resultSummary` case added once. */

export const STATUS_LABEL: Record<TaskStatus, string> = {
    pending: "Pending",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
};

export const STATUSES = Object.keys(STATUS_LABEL) as TaskStatus[];

export function statusTone(status: TaskStatus): "ok" | "warn" | "err" | "muted" {
    switch (status) {
        case "succeeded":
            return "ok";
        case "running":
        case "pending":
            return "warn";
        case "failed":
            return "err";
        case "cancelled":
            return "muted";
    }
}

/** Modal header accent — distinct from {@link statusTone}'s badge colors: running/
 *  pending reads as "in progress" (blue), not "caution" (amber), in that context. */
export function modalTone(status: TaskStatus): "info" | "ok" | "err" | "muted" {
    switch (status) {
        case "running":
        case "pending":
            return "info";
        case "succeeded":
            return "ok";
        case "failed":
            return "err";
        case "cancelled":
            return "muted";
    }
}

export function fmtTime(ms?: number): string {
    return ms ? new Date(ms).toLocaleString() : "—";
}

export function fmtDuration(run: TaskRun): string {
    if (!run.startedAt) {
        return "—";
    }
    const secs = Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000));
    return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function serverLabel(id: string | null, servers: ServerEntry[]): string {
    if (id === null) {
        return "Control plane";
    }
    return servers.find((s) => s.id === id)?.name ?? id;
}

export function specSummary(spec: TaskSpec): string {
    switch (spec.kind) {
        case "cmd":
            return spec.command;
        case "find_wan_ip":
            return "Discover external IP (STUN)";
        case "service_action":
            return `${spec.action} ${spec.unit}`;
        case "docker_stack_action":
            return `${spec.action} stack ${spec.project}`;
        case "docker_container_action":
            return `${spec.action} container ${spec.containerId.slice(0, 12)}`;
        case "docker_image_pull":
            return `docker pull ${spec.ref}`;
        case "docker_compose_action": {
            const target = spec.service ? `service ${spec.service}` : "stack";
            return spec.pullFirst ? `pull & ${spec.action} ${target}` : `${spec.action} ${target}`;
        }
        case "update_agent":
            return spec.force ? "Update agent (forced)" : "Update agent";
        case "debug_fake":
            return `Fake task (${(spec.durationMs / 1000).toFixed(1)}s${spec.fail ? ", failing" : ""})`;
        case "zfs_pool_create":
            return `Create pool ${spec.name}`;
        case "zfs_pool_destroy":
            return `Destroy pool ${spec.name}`;
        case "zfs_pool_import":
            return `Import pool ${spec.name}`;
        case "zfs_pool_export":
            return `Export pool ${spec.name}`;
        case "zfs_vdev_add":
            return `Add ${spec.vdev.type} vdev to ${spec.pool}`;
        case "zfs_device_replace":
            return `Replace ${spec.oldDevice} in ${spec.pool}`;
        case "zfs_scrub":
            return `${spec.action === "start" ? "Scrub" : "Stop scrub on"} ${spec.pool}`;
        case "zfs_dataset_create":
            return `Create ${spec.type} ${spec.parent}/${spec.name}`;
        case "zfs_dataset_destroy":
            return `Destroy dataset ${spec.name}`;
        case "zfs_snapshot_create":
            return `Snapshot ${spec.dataset}@${spec.name}`;
        case "zfs_snapshot_rollback":
            return `Rollback to ${spec.snapshot}`;
        case "zfs_snapshot_destroy":
            return `Destroy snapshot ${spec.snapshot}`;
        case "zfs_snapshot_clone":
            return `Clone ${spec.snapshot} → ${spec.target}`;
    }
}

export function resultSummary(run: TaskRun): string {
    if (run.status === "failed") {
        return run.error ?? "Failed";
    }
    if (!run.result) {
        return "—";
    }
    switch (run.result.kind) {
        case "cmd":
            return `exit ${run.result.exitCode}`;
        case "find_wan_ip":
            return run.result.ip ?? "not detected";
        case "debug_fake":
            return `${run.result.lines} log lines`;
        case "service_action":
        case "docker_stack_action":
        case "docker_container_action":
        case "docker_compose_action":
        case "update_agent":
        case "zfs_pool_create":
        case "zfs_pool_destroy":
        case "zfs_pool_import":
        case "zfs_pool_export":
        case "zfs_vdev_add":
        case "zfs_device_replace":
        case "zfs_scrub":
        case "zfs_dataset_create":
        case "zfs_dataset_destroy":
        case "zfs_snapshot_create":
        case "zfs_snapshot_rollback":
        case "zfs_snapshot_destroy":
        case "zfs_snapshot_clone":
            return "OK";
        case "docker_image_pull":
            return run.result.message;
    }
}
