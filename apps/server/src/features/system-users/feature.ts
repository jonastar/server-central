import type { SystemUserHostStatus, } from "@central/shared";
import type { AuthContext, AuthStore } from "../../auth";
import { defineFeature } from "../../feature";
import type { Fleet } from "../../fleet";
import { systemUserCreate, systemUserLookup, systemUserSetGroups, systemUsersList } from "./system-users";

export const createSystemUsersFeature = (fleet: Fleet, auth: AuthStore) => defineFeature({
    id: "system-users",
    name: "System users",
    description: "OS user account mapping and management across the fleet.",
    experimental: false,
    ops: {
        async list(data) {
            return systemUsersList(fleet.get(data.serverId), auth.listUsers());
        },

        async create(data, ctx?: AuthContext) {
            await systemUserCreate(fleet.get(data.serverId), data.username, data.groups ?? []);
        },

        async hostStatus(data) {
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

        async setGroups(data, ctx?: AuthContext) {
            await systemUserSetGroups(fleet.get(data.serverId), data.username, data.groups ?? []);
        },
    },
});


