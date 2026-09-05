import type { LogQuery } from "./logs";

// ---- Systemd -----------------------------------------------------------------

export interface ServiceInfo {
    /** e.g. "ssh.service". */
    unit: string;
    /** loaded | not-found | masked | … */
    load: string;
    /** active | inactive | failed | activating | … */
    active: string;
    /** running | exited | dead | failed | … */
    sub: string;
    description: string;
    /** From unit-files: enabled | disabled | static | masked | … (absent if unknown). */
    enabledState?: string;
}

export interface SystemdState {
    available: boolean;
    error?: string;
    services: ServiceInfo[];
}

export type ServiceAction = "start" | "stop" | "restart" | "enable" | "disable";


/**
 * List services, view logs and unit files. Service actions
 * (start/stop/restart/enable/disable) moved to the task system's
 * `service_action` kind via `runTask`, for run history + logs.
 */
export interface SystemdOperations {
    list: { data: { serverId: string }; response: SystemdState };
    serviceLogs: { data: { serverId: string; unit: string; priority?: string } & LogQuery; response: { logs: string } };
    unitFile: { data: { serverId: string; unit: string }; response: { content: string } };
}
