import type { TaskFindWanIp, TaskFindWanIpResult } from "@central/shared";
import { defineFeature } from "../../feature";
import type { Fleet } from "../../fleet";
import { getNetworkInfo } from "./network";
import { discoverWanIp } from "../../stun";
import type { TaskCtx } from "../../tasks/types";

export const createNetworkFeature = (fleet: Fleet) => defineFeature({
    id: "network",
    name: "Networking",
    description: "Network interface/routing info on a host.",
    experimental: false,
    ops: {
        async getInfo(data) {
            return getNetworkInfo(fleet.get(data.serverId));
        },
    },
    tasks: {
        async find_wan_ip(_spec: TaskFindWanIp, ctx: TaskCtx): Promise<TaskFindWanIpResult> {
            // Targeted: STUN from the agent's own host (its network vantage point).
            // Untargeted: STUN from the control plane itself.
            const { ip } = ctx.agent ? await ctx.agent.discoverStun() : { ip: await discoverWanIp() };
            return { kind: "find_wan_ip", ip };
        },
    },
});


