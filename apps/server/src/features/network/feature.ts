import type { NetworkInfo } from "@central/shared";
import type { Feature, FeatureApiHandlers } from "../../feature";
import type { Fleet } from "../../fleet";
import { getNetworkInfo } from "./network";

export function createNetworkFeature(fleet: Fleet): Feature<NetworkOps> {
    return {
        descriptor: {
            id: "network",
            name: "Networking",
            description: "Network interface/routing info on a host.",
            experimental: false,
        },
        apiHandlers() {
            return networkApiHandlers(fleet);
        },
    };
}

export type NetworkOps = "getNetworkInfo";

export function networkApiHandlers(fleet: Fleet): FeatureApiHandlers<NetworkOps> {
    return {
        async handleGetNetworkInfo(data: { serverId: string }): Promise<NetworkInfo> {
            return getNetworkInfo(fleet.get(data.serverId));
        },
    };
}
