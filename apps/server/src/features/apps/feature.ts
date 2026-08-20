import type { App, AppDetection, AppStatus, DockerExecResult } from "@central/shared";
import type { AppStore } from "./apps";
import { composeServiceExec, getAppLogs, getAppStatus, validateComposeContent } from "../docker/docker";
import type { Feature, FeatureApiHandlers } from "../../feature";
import type { Fleet } from "../../fleet";

// See doc/idea_app_system.md. Not role-gated beyond "any authenticated user",
// same as every other non-owner-gated endpoint (see `requireOwner` in
// features/auth/feature.ts).

export function createAppsFeature(apps: AppStore, fleet: Fleet): Feature<AppsOps> {
    return {
        descriptor: {
            id: "apps",
            name: "Apps",
            description: "Directory + compose stack apps running on a host.",
            experimental: false,
        },
        async init() {
            await apps.init();
        },
        apiHandlers() {
            return appsApiHandlers(apps, fleet);
        },
    };
}

export type AppsOps = "listApps" | "createApp" | "detectApp" | "importApp" | "deleteApp"
    | "getAppStatus" | "getAppLogs" | "appServiceExec" | "validateComposeContent";

export function appsApiHandlers(apps: AppStore, fleet: Fleet): FeatureApiHandlers<AppsOps> {
    return {
        async handleListApps(): Promise<App[]> {
            return apps.list();
        },

        async handleCreateApp(data: { name: string; hostId: string; dir: string }): Promise<App> {
            return apps.create(data.name, data.hostId, data.dir);
        },

        async handleDetectApp(data: { hostId: string; dir: string }): Promise<AppDetection> {
            return apps.detect(data.hostId, data.dir);
        },

        async handleImportApp(data: { hostId: string; dir: string; name: string }): Promise<App> {
            return apps.import(data.hostId, data.dir, data.name);
        },

        async handleDeleteApp(data: { appId: string; deleteDir: boolean }): Promise<void> {
            await apps.delete(data.appId, data.deleteDir);
        },

        async handleGetAppStatus(data: { appId: string }): Promise<AppStatus> {
            const app = apps.get(data.appId);
            return getAppStatus(fleet.get(app.hostId), app.dir, app.composeFile, app.project);
        },

        async handleGetAppLogs(data: { appId: string; service?: string; tail?: number }): Promise<{ logs: string }> {
            const app = apps.get(data.appId);
            const logs = await getAppLogs(fleet.get(app.hostId), app.dir, app.composeFile, app.project, data.service, data.tail ?? 500);
            return { logs };
        },

        async handleAppServiceExec(data: { appId: string; service: string; command: string }): Promise<DockerExecResult> {
            const app = apps.get(data.appId);
            return composeServiceExec(fleet.get(app.hostId), app.dir, app.composeFile, app.project, data.service, data.command);
        },

        async handleValidateComposeContent(data: { appId: string; content: string }): Promise<{ valid: true } | { valid: false; error: string }> {
            const app = apps.get(data.appId);
            return validateComposeContent(fleet.get(app.hostId), app.dir, app.project, data.content);
        },
    };
}
