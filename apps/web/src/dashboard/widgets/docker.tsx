import type { ComposeStackRunStatus, HostComposeStacks } from "@central/shared";
import { EmptyState, ErrorBanner } from "../../components/ui";
import { observedStatus, stackTone, StatusBadge } from "../../components/docker/status";
import { useHostPoll } from "../useHostPoll";
import { defineWidget, type WidgetConfigProps, type WidgetProps } from "../types";
import styles from "../HostDashboard.module.css";
import shared from "../../styles/shared.module.css";

// Docker's contribution to a host's overview. Tier 2 in
// doc/idea_host_dashboard.md §2: request/response data, polled through the
// shared `useHostPoll` cache so three of these cards cost one request, not three.
//
// They read `readHostComposeStacks`, not `listHostComposeStacks` — the latter
// *adopts* observed stacks into the registry as a side effect of reading, which
// is defensible for a page you navigated to and wrong for a card that polls the
// landing page of every host every ten seconds.

const FEATURE_ID = "docker";

/** One row of the merged registered/observed view, the same merge DockerStacks
 *  does, minus the actions. */
interface StackRow {
    project: string;
    label: string;
    status: ComposeStackRunStatus;
    running: number;
    total: number;
}

function mergeStacks(state: HostComposeStacks): StackRow[] {
    const byProject = new Map<string, StackRow>();
    for (const observed of state.observed) {
        byProject.set(observed.project, {
            project: observed.project,
            label: observed.project,
            status: observedStatus(observed),
            running: observed.running,
            total: observed.containers,
        });
    }
    for (const stack of state.stacks) {
        const existing = byProject.get(stack.project);
        byProject.set(stack.project, existing
            ? { ...existing, label: stack.name }
            // Registered but nothing running: it's simply down.
            : { project: stack.project, label: stack.name, status: "down", running: 0, total: 0 });
    }
    return [...byProject.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function useStacks(serverId: string, online: boolean) {
    return useHostPoll("readHostComposeStacks", { hostId: serverId }, { enabled: online });
}

function StackRowLine({ row }: { row: StackRow }) {
    return (
        <div className={styles["stack-row"]}>
            <StatusBadge tone={stackTone(row.status)}>{row.status}</StatusBadge>
            <span className={styles["stack-name"]} title={row.project}>{row.label}</span>
            <span className={shared.dim}>{row.total > 0 ? `${row.running}/${row.total}` : "—"}</span>
        </div>
    );
}

function Stacks({ serverId, entry }: WidgetProps) {
    const online = entry.status.state === "online";
    const { data, error, loading } = useStacks(serverId, online);

    if (!online) {
        return <EmptyState>Server is not connected.</EmptyState>;
    }
    if (error) {
        return <ErrorBanner>{error}</ErrorBanner>;
    }
    if (loading || !data) {
        return <EmptyState>Loading…</EmptyState>;
    }
    if (!data.available) {
        return <EmptyState>Docker is not available on this server{data.error ? `: ${data.error}` : "."}</EmptyState>;
    }
    const rows = mergeStacks(data);
    if (rows.length === 0) {
        return <EmptyState>No compose stacks on this host.</EmptyState>;
    }
    return (
        <div className={styles["stack-list"]}>
            {rows.map((row) => <StackRowLine key={row.project} row={row} />)}
        </div>
    );
}

// ---- One pinned stack ---------------------------------------------------------
//
// The case that motivated instancing: a host running eight stacks where you only
// care about two of them on the landing page. Two cards, same widget id,
// different config.

interface PinnedStackConfig {
    project?: string;
    [key: string]: unknown;
}

function PinnedStack({ serverId, entry, config }: WidgetProps<PinnedStackConfig>) {
    const online = entry.status.state === "online";
    const { data, error, loading } = useStacks(serverId, online);

    if (!config.project) {
        return <EmptyState>No stack chosen — pick one in this card's settings.</EmptyState>;
    }
    if (!online) {
        return <EmptyState>Server is not connected.</EmptyState>;
    }
    if (error) {
        return <ErrorBanner>{error}</ErrorBanner>;
    }
    if (loading || !data) {
        return <EmptyState>Loading…</EmptyState>;
    }
    const row = mergeStacks(data).find((r) => r.project === config.project);
    if (!row) {
        return <EmptyState>Stack "{config.project}" isn't on this host.</EmptyState>;
    }
    return (
        <div className={styles["stack-list"]}>
            <StackRowLine row={row} />
        </div>
    );
}

function PinnedStackConfigForm({ serverId, entry, config, onChange }: WidgetConfigProps<PinnedStackConfig>) {
    const { data, error } = useStacks(serverId, entry.status.state === "online");
    const rows = data ? mergeStacks(data) : [];
    return (
        <label className={styles["config-field"]}>
            <span>Stack</span>
            <select
                value={config.project ?? ""}
                onChange={(e) => onChange({ ...config, project: e.target.value || undefined })}
            >
                <option value="">Choose a stack…</option>
                {rows.map((row) => (
                    <option key={row.project} value={row.project}>{row.label}</option>
                ))}
                {/* Keep a pinned stack selectable even when it isn't running
                    right now, so opening settings can't silently clear it. */}
                {config.project && !rows.some((r) => r.project === config.project) && (
                    <option value={config.project}>{config.project} (not found)</option>
                )}
            </select>
            {error && <span className={shared.dim}>{error}</span>}
        </label>
    );
}

// ---- Docker totals -------------------------------------------------------------

function Stat({ label, value }: { label: string; value: string | number }) {
    return (
        <div className={styles["stat-cell"]}>
            <div className={styles["stat-value"]}>{value}</div>
            <div className={styles["stat-label"]}>{label}</div>
        </div>
    );
}

function Summary({ serverId, entry }: WidgetProps) {
    const online = entry.status.state === "online";
    const { data, error, loading } = useHostPoll("dockerOverview", { serverId }, { enabled: online });

    if (!online) {
        return <EmptyState>Server is not connected.</EmptyState>;
    }
    if (error) {
        return <ErrorBanner>{error}</ErrorBanner>;
    }
    if (loading || !data) {
        return <EmptyState>Loading…</EmptyState>;
    }
    if (!data.available) {
        return <EmptyState>Docker is not available on this server{data.error ? `: ${data.error}` : "."}</EmptyState>;
    }
    return (
        <div className={styles["stat-row"]}>
            <Stat label="running / total" value={`${data.containersRunning}/${data.containersTotal}`} />
            <Stat label="stacks" value={data.stacks} />
            <Stat label="volumes" value={data.volumes} />
            <Stat label="images" value={data.images} />
        </div>
    );
}

export const dockerWidgets = [
    defineWidget({
        id: "docker.stacks",
        featureId: FEATURE_ID,
        title: "Compose stacks",
        description: "Every compose stack on this host and whether it's up.",
        requires: "docker",
        defaultSpan: 2,
        inDefaultLayout: 60,
        component: Stacks,
    }),
    defineWidget<PinnedStackConfig>({
        id: "docker.stack",
        featureId: FEATURE_ID,
        title: "Stack",
        description: "One chosen compose stack — add a card per stack you actually watch.",
        requires: "docker",
        defaultSpan: 1,
        component: PinnedStack,
        configForm: PinnedStackConfigForm,
        defaultConfig: {},
        label: (config) => config.project ?? null,
    }),
    defineWidget({
        id: "docker.summary",
        featureId: FEATURE_ID,
        title: "Docker totals",
        description: "Container, stack, volume and image counts.",
        requires: "docker",
        defaultSpan: 1,
        component: Summary,
    }),
];
