import type { DirEntry, FileContent, HostDevices, MountsState } from "@central/shared";
import type { Feature, FeatureApiHandlers } from "../../feature";
import type { Fleet } from "../../fleet";
import { getMounts } from "./host-mounts";
import { listHostDevices } from "./host-devices";

export function createFilesFeature(fleet: Fleet): Feature<FilesOps> {
    return {
        descriptor: {
            id: "files",
            name: "Files",
            description: "Remote filesystem browsing/editing, mount info, and device inventory on a host.",
            experimental: false,
        },
        apiHandlers() {
            return filesApiHandlers(fleet);
        },
    };
}

export type FilesOps = "listDir" | "readFile" | "writeFile" | "uploadFile" | "createDir" | "deletePath" | "renamePath" | "getMounts" | "listHostDevices";

export function filesApiHandlers(fleet: Fleet): FeatureApiHandlers<FilesOps> {
    return {
        async handleListDir(data: { serverId: string; path: string }): Promise<{ path: string; entries: DirEntry[] }> {
            return fleet.get(data.serverId).listDir(data.path);
        },

        async handleReadFile(data: { serverId: string; path: string }): Promise<FileContent> {
            return fleet.get(data.serverId).readFile(data.path);
        },

        async handleWriteFile(data: { serverId: string; path: string; content: string }): Promise<void> {
            await fleet.get(data.serverId).writeFile(data.path, data.content);
        },

        async handleUploadFile(data: { serverId: string; path: string; contentBase64: string }): Promise<void> {
            await fleet.get(data.serverId).uploadFile(data.path, data.contentBase64);
        },

        async handleCreateDir(data: { serverId: string; path: string }): Promise<void> {
            await fleet.get(data.serverId).createDir(data.path);
        },

        async handleDeletePath(data: { serverId: string; path: string }): Promise<void> {
            await fleet.get(data.serverId).deletePath(data.path);
        },

        async handleRenamePath(data: { serverId: string; from: string; to: string }): Promise<void> {
            await fleet.get(data.serverId).renamePath(data.from, data.to);
        },

        async handleGetMounts(data: { serverId: string }): Promise<MountsState> {
            return getMounts(fleet.get(data.serverId));
        },

        /** Lives here rather than under Docker: it's host hardware inventory, the
         *  same shelf as `getMounts`, and works on a host with no Docker at all.
         *  The compose editor's `devices:` picker is just its first caller. */
        async handleListHostDevices(data: { serverId: string }): Promise<HostDevices> {
            return listHostDevices(fleet.get(data.serverId));
        },
    };
}
