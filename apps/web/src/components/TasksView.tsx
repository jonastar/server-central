import { Fragment, useState } from "react";
import type { TaskRun, TaskStatus } from "@central/shared";
import { useConnection } from "../hooks/useConnection";
import { api } from "../api";
import { connectionManager } from "../connection";
import { cx } from "../utils";
import { DetailPair, EmptyState, ErrorBanner } from "./ui";
import { LogViewer } from "./LogViewer";

const STATUS_LABEL: Record<TaskStatus, string> = {
    pending: "Pending",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
};

const STATUSES = Object.keys(STATUS_LABEL) as TaskStatus[];

function statusTone(status: TaskStatus): "ok" | "warn" | "err" | "muted" {
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

function fmtTime(ms?: number): string {
    return ms ? new Date(ms).toLocaleString() : "—";
}

function fmtDuration(run: TaskRun): string {
    if (!run.startedAt) {
        return "—";
    }
    const secs = Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000));
    return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function specSummary(spec: TaskRun["spec"]): string {
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
    }
}

function resultSummary(run: TaskRun): string {
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
        case "service_action":
        case "docker_stack_action":
        case "docker_container_action":
            return "OK";
        case "docker_image_pull":
            return run.result.message;
    }
}

/**
 * Run history for the task system: every run the control plane knows about
 * (control-plane-local and per-server), live-updating via `taskUpdate`/`taskLog`.
 * Expanding a row lazily seeds its log buffer via `getTaskLogs` — most kinds emit
 * none, so the log panel only appears once there's something to show.
 */
export function TasksView() {
    const { tasks, servers, taskLogs } = useConnection();
    const [kindFilter, setKindFilter] = useState<string>("all");
    const [statusFilter, setStatusFilter] = useState<"all" | TaskStatus>("all");
    const [expanded, setExpanded] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const kinds = [...new Set(tasks.map((t) => t.spec.kind))];

    function serverName(id: string | null): string {
        if (id === null) {
            return "Control plane";
        }
        return servers.find((s) => s.id === id)?.name ?? id;
    }

    const shown = tasks.filter((t) =>
        (kindFilter === "all" || t.spec.kind === kindFilter)
        && (statusFilter === "all" || t.status === statusFilter));

    async function toggle(run: TaskRun) {
        const next = expanded === run.id ? null : run.id;
        setExpanded(next);
        if (next && taskLogs[run.id] === undefined) {
            try {
                const lines = await api("getTaskLogs", { id: run.id });
                connectionManager.seedTaskLogs(run.id, lines);
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            }
        }
    }

    return (
        <div className="view">
            <header className="view-header">
                <h1>Tasks</h1>
            </header>

            {error && <ErrorBanner>{error}</ErrorBanner>}

            <section className="panel">
                <div className="panel-head">
                    <h3>Runs ({shown.length})</h3>
                    <select className="log-select" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)}>
                        <option value="all">All kinds</option>
                        {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                    <select
                        className="log-select"
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value as "all" | TaskStatus)}
                    >
                        <option value="all">All statuses</option>
                        {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                    </select>
                </div>

                {shown.length === 0 ? (
                    <EmptyState>No task runs yet.</EmptyState>
                ) : (
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th className="col-expander" />
                                <th>Kind</th>
                                <th>Target</th>
                                <th>Status</th>
                                <th>Started</th>
                                <th>Duration</th>
                                <th>Result</th>
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map((run) => {
                                const isExpanded = expanded === run.id;
                                const tone = statusTone(run.status);
                                const lines = taskLogs[run.id];
                                return (
                                    <Fragment key={run.id}>
                                        <tr
                                            className={cx("row-clickable", `row-status-${tone}`, isExpanded && "row-active")}
                                            onClick={() => void toggle(run)}
                                        >
                                            <td className="col-expander"><span className={cx("row-expander", isExpanded && "open")}>▸</span></td>
                                            <td><b>{run.spec.kind}</b></td>
                                            <td className="dim">{serverName(run.target)}</td>
                                            <td><span className={cx("badge", `badge-${tone}`)}>{STATUS_LABEL[run.status]}</span></td>
                                            <td className="dim">{fmtTime(run.startedAt ?? run.createdAt)}</td>
                                            <td className="dim">{fmtDuration(run)}</td>
                                            <td className="dim cmd-cell" title={resultSummary(run)}>{resultSummary(run)}</td>
                                        </tr>
                                        {isExpanded && (
                                            <tr className="row-detail-tr">
                                                <td />
                                                <td colSpan={6}>
                                                    <div className="row-detail-wrap"><div className="row-detail">
                                                        <div className="row-detail-meta">
                                                            <DetailPair label="Run id"><span className="mono">{run.id}</span></DetailPair>
                                                            <DetailPair label="Spec">{specSummary(run.spec)}</DetailPair>
                                                            <DetailPair label="Trigger">
                                                                {run.trigger.kind}
                                                                {run.trigger.kind === "manual" && run.trigger.userId ? ` (${run.trigger.userId})` : ""}
                                                            </DetailPair>
                                                            <DetailPair label="Created">{fmtTime(run.createdAt)}</DetailPair>
                                                            <DetailPair label="Finished">{fmtTime(run.finishedAt)}</DetailPair>
                                                            {run.error && <DetailPair label="Error">{run.error}</DetailPair>}
                                                        </div>
                                                        {lines && lines.length > 0 && (
                                                            <div className="row-detail-body">
                                                                <LogViewer text={lines.map((l) => l.text).join("\n")} />
                                                            </div>
                                                        )}
                                                    </div></div>
                                                </td>
                                            </tr>
                                        )}
                                    </Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </section>
        </div>
    );
}
