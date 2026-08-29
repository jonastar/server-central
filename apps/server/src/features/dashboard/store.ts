import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DashboardWidgetInstance, HostDashboard, WidgetSpan } from "@central/shared";
import { DASHBOARD_MAX_CONFIG_BYTES, DASHBOARD_MAX_WIDGETS, WIDGET_SPANS } from "@central/shared";
import { CONFIG_DIR, writeFileAtomic } from "../../config";

/** hostId → the arrangement someone saved for it. A host with no entry has
 *  never been customized and gets the client's registry default. */
type DashboardsPersisted = Record<string, HostDashboard>;

/**
 * Validate one card.
 *
 * Structure only, on purpose: `config` is a widget-defined blob this package has
 * no schema for (doc/idea_host_dashboard.md §3). What's checked is what a bad
 * client could use to grow the state file or to write a layout no build can
 * render — an unknown span, a duplicate instance id, an oversized config.
 */
function validateWidget(raw: DashboardWidgetInstance, seen: Set<string>): DashboardWidgetInstance {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    if (!id) {
        throw new Error("Every dashboard widget needs an instance id");
    }
    if (seen.has(id)) {
        throw new Error(`Duplicate dashboard widget instance id: ${id}`);
    }
    seen.add(id);

    const widget = typeof raw.widget === "string" ? raw.widget.trim() : "";
    if (!widget) {
        throw new Error(`Dashboard widget "${id}" names no widget type`);
    }
    if (!WIDGET_SPANS.includes(raw.span)) {
        throw new Error(`Dashboard widget "${widget}" has an invalid span: ${String(raw.span)}`);
    }

    let config: Record<string, unknown> | undefined;
    if (raw.config !== undefined && raw.config !== null) {
        if (typeof raw.config !== "object" || Array.isArray(raw.config)) {
            throw new Error(`Dashboard widget "${widget}" config must be an object`);
        }
        const serialized = JSON.stringify(raw.config);
        if (serialized.length > DASHBOARD_MAX_CONFIG_BYTES) {
            throw new Error(`Dashboard widget "${widget}" config is too large (${serialized.length} > ${DASHBOARD_MAX_CONFIG_BYTES} bytes)`);
        }
        config = raw.config;
    }

    return { id, widget, span: raw.span as WidgetSpan, ...(config ? { config } : {}) };
}

/**
 * File-backed per-host dashboard layouts (`.sc-data/dashboards.json`), same
 * atomic-write shape as the other stores.
 */
export class DashboardStore {
    private state: DashboardsPersisted = {};
    private readonly file: string;

    constructor(dataDir: string = CONFIG_DIR) {
        this.file = path.join(dataDir, "dashboards.json");
    }

    async init(): Promise<void> {
        try {
            this.state = JSON.parse(await fs.readFile(this.file, "utf8")) as DashboardsPersisted;
        } catch {
            this.state = {};
        }
    }

    /** `null` for a host nobody has arranged — the client defaults it. */
    get(hostId: string): HostDashboard | null {
        return this.state[hostId] ?? null;
    }

    async set(hostId: string, widgets: DashboardWidgetInstance[]): Promise<HostDashboard> {
        if (!hostId) {
            throw new Error("A host id is required");
        }
        if (widgets.length > DASHBOARD_MAX_WIDGETS) {
            throw new Error(`A dashboard can hold at most ${DASHBOARD_MAX_WIDGETS} widgets`);
        }
        const seen = new Set<string>();
        const dashboard: HostDashboard = {
            hostId,
            widgets: widgets.map((w) => validateWidget(w, seen)),
            updatedAt: Date.now(),
        };
        this.state = { ...this.state, [hostId]: dashboard };
        await this.persist();
        return dashboard;
    }

    /** Forget the arrangement, so the host falls back to the registry default.
     *  Deliberately removes the row rather than storing an empty widget list —
     *  an empty list is itself a valid layout ("show me nothing"). */
    async reset(hostId: string): Promise<void> {
        if (!(hostId in this.state)) {
            return;
        }
        const { [hostId]: _dropped, ...rest } = this.state;
        this.state = rest;
        await this.persist();
    }

    private async persist(): Promise<void> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await writeFileAtomic(this.file, JSON.stringify(this.state, null, 2));
    }
}
