import type { HostCapabilityReport } from "@central/shared";
import { composeHostProbes } from "../feature";
import { agentFeatures } from "./features";

/**
 * Probe this host for every capability the node-side feature registry declares.
 *
 * The probes themselves live with their features (`features/<id>/feature.ts`),
 * next to the code that knows why the capability matters — this is only the
 * entry point the connect path and the on-demand re-check both call.
 */
export function probeHostCapabilities(): Promise<HostCapabilityReport> {
    return composeHostProbes(agentFeatures);
}
