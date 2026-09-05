import type { DirEntry, FileContent, HostDevices, MountsState } from "@central/shared";
import { defineFeature } from "../../feature";
import type { Fleet } from "../../fleet";
import { getMounts } from "./host-mounts";
import { listHostDevices } from "./host-devices";

export const createFilesFeature = (fleet: Fleet) => defineFeature({
    id: "files",
    name: "Files",
    description: "Remote filesystem browsing/editing, mount info, and device inventory on a host.",
    experimental: false,
    ops: {
        async listDir(data) {
            return fleet.get(data.serverId).listDir(data.path);
        },

        async read(data) {
            return fleet.get(data.serverId).readFile(data.path);
        },

        async write(data) {
            await fleet.get(data.serverId).writeFile(data.path, data.content);
        },

        async upload(data) {
            await fleet.get(data.serverId).uploadFile(data.path, data.contentBase64);
        },

        async createDir(data) {
            await fleet.get(data.serverId).createDir(data.path);
        },

        async delete(data) {
            await fleet.get(data.serverId).deletePath(data.path);
        },

        async rename(data) {
            await fleet.get(data.serverId).renamePath(data.from, data.to);
        },

        async getMounts(data) {
            return getMounts(fleet.get(data.serverId));
        },

        /** Lives here rather than under Docker: it's host hardware inventory, the
         *  same shelf as `getMounts`, and works on a host with no Docker at all.
         *  The compose editor's `devices:` picker is just its first caller. */
        async listDevices(data) {
            return listHostDevices(fleet.get(data.serverId));
        },
    },
});


