import type { ComposeStack, ComposeStackDetection, ComposeStackStatus, HostComposeStacks } from "@central/shared";
import type { ComposeStackStore } from "./store";
import { dockerStacks, getComposeStackLogs, getComposeStackStatus, validateComposeContent } from "../docker/docker";
import { defineFeature } from "../../feature";
import type { Fleet } from "../../fleet";

// SC-managed compose stacks: a directory on a host holding a compose file,
// `sc-stack.json`, and `volumes/`. Surfaced under the host's Docker → Stacks
// section alongside the label-derived stacks `dockerStacks()` observes.
// See doc/idea_app_system.md. Not role-gated beyond "any authenticated user",
// same as every other non-owner-gated endpoint (see `requireOwner` in
// features/auth/feature.ts).

export const createComposeStacksFeature = (stacks: ComposeStackStore, fleet: Fleet) => defineFeature({
    id: "compose",
    name: "Compose stacks",
    description: "SC-managed docker compose stacks on a host.",
    experimental: false,
    requiresHostCapability: "docker",
    
    async init() {
        await stacks.init();
            },
    ops: {
        async list() {
            return stacks.list();
        },

        /** Adopts as it reads — see HostComposeStacks. Docker being unavailable
         *  is not an error here: the host's registered stacks are still listed,
         *  just without live container state to merge in. */
        async listForHost(data) {
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

        /** The same merge, minus the adoption write — see `readHostComposeStacks`
         *  in the protocol. The dashboard's stacks widget polls this on every
         *  host overview, and a read that registers things as a side effect is
         *  not something to do on a timer. */
        async readForHost(data) {
            const observed = await dockerStacks(fleet.get(data.hostId));
            const registered = stacks.list().filter((s) => s.hostId === data.hostId);
            if (!observed.available) {
                return { available: false, error: observed.error, stacks: registered, observed: [] };
            }
            return { available: true, stacks: registered, observed: observed.stacks };
        },

        async create(data) {
            return stacks.create(data.name, data.hostId, data.dir, data.content);
        },

        async detect(data) {
            return stacks.detect(data.hostId, data.dir);
        },

        async import(data) {
            return stacks.import(data.hostId, data.dir, data.name);
        },

        async delete(data) {
            await stacks.delete(data.stackId, data.deleteDir);
        },

        async getStatus(data) {
            const stack = stacks.get(data.stackId);
            return getComposeStackStatus(fleet.get(stack.hostId), stack.dir, stack.composeFile, stack.project);
        },

        async getLogs(data) {
            const stack = stacks.get(data.stackId);
            const logs = await getComposeStackLogs(fleet.get(stack.hostId), stack.dir, stack.composeFile, stack.project, data.service, data.tail ?? 500);
            return { logs };
        },


        async validateContent(data) {
            const stack = stacks.get(data.stackId);
            return validateComposeContent(fleet.get(stack.hostId), stack.dir, stack.project, data.content);
        },
    },
});


