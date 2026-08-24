import type { ComposeStack, ComposeStackDetection, ComposeStackStatus, HostComposeStacks } from "@central/shared";
import type { ComposeStackStore } from "./store";
import { dockerStacks, getComposeStackLogs, getComposeStackStatus, validateComposeContent } from "../docker/docker";
import type { Feature, FeatureApiHandlers } from "../../feature";
import type { Fleet } from "../../fleet";

// SC-managed compose stacks: a directory on a host holding a compose file,
// `sc-stack.json`, and `volumes/`. Surfaced under the host's Docker → Stacks
// section alongside the label-derived stacks `dockerStacks()` observes.
// See doc/idea_app_system.md. Not role-gated beyond "any authenticated user",
// same as every other non-owner-gated endpoint (see `requireOwner` in
// features/auth/feature.ts).

export function createComposeStacksFeature(stacks: ComposeStackStore, fleet: Fleet): Feature<ComposeStacksOps> {
    return {
        descriptor: {
            id: "compose-stacks",
            name: "Compose stacks",
            description: "SC-managed docker compose stacks on a host.",
            experimental: false,
            requiresHostCapability: "docker",
        },
        async init() {
            await stacks.init();
        },
        apiHandlers() {
            return composeStacksApiHandlers(stacks, fleet);
        },
    };
}

export type ComposeStacksOps = "listComposeStacks" | "listHostComposeStacks" | "createComposeStack" | "detectComposeStack" | "importComposeStack" | "deleteComposeStack"
    | "getComposeStackStatus" | "getComposeStackLogs" | "validateComposeContent";

export function composeStacksApiHandlers(stacks: ComposeStackStore, fleet: Fleet): FeatureApiHandlers<ComposeStacksOps> {
    return {
        async handleListComposeStacks(): Promise<ComposeStack[]> {
            return stacks.list();
        },

        /** Adopts as it reads — see HostComposeStacks. Docker being unavailable
         *  is not an error here: the host's registered stacks are still listed,
         *  just without live container state to merge in. */
        async handleListHostComposeStacks(data: { hostId: string }): Promise<HostComposeStacks> {
            const observed = await dockerStacks(fleet.get(data.hostId));
            if (!observed.available) {
                return {
                    available: false,
                    error: observed.error,
                    stacks: stacks.list().filter((s) => s.hostId === data.hostId),
                    observed: [],
                };
            }
            return {
                available: true,
                stacks: await stacks.syncHost(data.hostId, observed.stacks),
                observed: observed.stacks,
            };
        },

        async handleCreateComposeStack(data: { name: string; hostId: string; dir: string; content?: string }): Promise<ComposeStack> {
            return stacks.create(data.name, data.hostId, data.dir, data.content);
        },

        async handleDetectComposeStack(data: { hostId: string; dir: string }): Promise<ComposeStackDetection> {
            return stacks.detect(data.hostId, data.dir);
        },

        async handleImportComposeStack(data: { hostId: string; dir: string; name: string }): Promise<ComposeStack> {
            return stacks.import(data.hostId, data.dir, data.name);
        },

        async handleDeleteComposeStack(data: { stackId: string; deleteDir: boolean }): Promise<void> {
            await stacks.delete(data.stackId, data.deleteDir);
        },

        async handleGetComposeStackStatus(data: { stackId: string }): Promise<ComposeStackStatus> {
            const stack = stacks.get(data.stackId);
            return getComposeStackStatus(fleet.get(stack.hostId), stack.dir, stack.composeFile, stack.project);
        },

        async handleGetComposeStackLogs(data: { stackId: string; service?: string; tail?: number }): Promise<{ logs: string }> {
            const stack = stacks.get(data.stackId);
            const logs = await getComposeStackLogs(fleet.get(stack.hostId), stack.dir, stack.composeFile, stack.project, data.service, data.tail ?? 500);
            return { logs };
        },


        async handleValidateComposeContent(data: { stackId: string; content: string }): Promise<{ valid: true } | { valid: false; error: string }> {
            const stack = stacks.get(data.stackId);
            return validateComposeContent(fleet.get(stack.hostId), stack.dir, stack.project, data.content);
        },
    };
}
