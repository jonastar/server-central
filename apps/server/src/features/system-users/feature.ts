import type { SystemUserHostStatus, SystemUsersState } from "@central/shared";
import type { AuthContext, AuthStore } from "../../auth";
import type { Feature, FeatureApiHandlers } from "../../feature";
import type { Fleet } from "../../fleet";
import { systemUserCreate, systemUserLookup, systemUserSetGroups, systemUsersList } from "./system-users";

export function createSystemUsersFeature(fleet: Fleet, auth: AuthStore): Feature<SystemUsersOps> {
    return {
        descriptor: {
            id: "system-users",
            name: "System users",
            description: "OS user account mapping and management across the fleet.",
            experimental: false,
        },
        apiHandlers() {
            return systemUsersApiHandlers(fleet, auth);
        },
    };
}

export type SystemUsersOps = "systemUsersList" | "systemUserCreate" | "systemUserHostStatus" | "systemUserSetGroups";

export function systemUsersApiHandlers(fleet: Fleet, auth: AuthStore): FeatureApiHandlers<SystemUsersOps> {
    return {
        async handleSystemUsersList(data: { serverId: string }): Promise<SystemUsersState> {
            return systemUsersList(fleet.get(data.serverId), auth.listUsers());
        },

        async handleSystemUserCreate(data: { serverId: string; username: string; groups: string[] }, ctx?: AuthContext): Promise<void> {
            await systemUserCreate(fleet.get(data.serverId), data.username, data.groups ?? []);
        },

        async handleSystemUserHostStatus(data: { username: string }): Promise<SystemUserHostStatus[]> {
            return Promise.all(fleet.entries().map(async (entry): Promise<SystemUserHostStatus> => {
                const base = { serverId: entry.id, serverName: entry.name };
                if (entry.status.state !== "online") {
                    return { ...base, status: "offline" };
                }
                try {
                    const res = await systemUserLookup(fleet.get(entry.id), data.username);
                    if (res.error) {
                        return { ...base, status: "error", error: res.error };
                    }
                    return res.found ? { ...base, status: "exists", user: res.user } : { ...base, status: "missing" };
                } catch (err) {
                    return { ...base, status: "error", error: err instanceof Error ? err.message : String(err) };
                }
            }));
        },

        async handleSystemUserSetGroups(data: { serverId: string; username: string; groups: string[] }, ctx?: AuthContext): Promise<void> {
            await systemUserSetGroups(fleet.get(data.serverId), data.username, data.groups ?? []);
        },
    };
}
