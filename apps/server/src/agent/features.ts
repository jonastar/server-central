import { defineAgentFeatures } from "../feature";
import { dockerAgentFeature } from "../features/docker/feature";
import { systemdAgentFeature } from "../features/systemd/feature";
import { zfsAgentFeature } from "../features/zfs/feature";

/**
 * The node-side feature registry — the agent's counterpart to `index.ts`'s
 * `hostFeatures`.
 *
 * Separate from that registry rather than the same objects because the
 * control-plane factories take `Fleet`/`AuthStore`/`AppStore`, none of which
 * exist on a managed host (see the AgentFeature docs in feature.ts). Nothing
 * here takes a dependency, so unlike the control-plane registry there's no boot
 * order and no `init` — it's a plain list, constructed at import.
 *
 * Only features with something to contribute on the node appear. A feature
 * declaring `requiresHostCapability` control-plane-side without a matching
 * probe here is caught by `assertHostProbeCoverage` in the tests.
 */
export const agentFeatures = defineAgentFeatures(
    zfsAgentFeature(),
    systemdAgentFeature(),
    dockerAgentFeature(),
);
