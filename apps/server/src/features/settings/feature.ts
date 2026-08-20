import { AGENT_VERSION } from "@central/shared";
import { readConfig, setDomain as persistSetDomain, setIssuerUrl as persistSetIssuerUrl } from "../../config";
import type { Feature, FeatureApiHandlers } from "../../feature";
import type { NodeServer } from "../../node-server";
import { controlPlaneStatus, updateControlPlane } from "../../server-install";

// The control plane's own settings: the domain/issuer URL other subsystems read
// out of config.ts, plus its self-update. Config stays one flat file (config.ts)
// rather than a per-feature store — see doc/idea_feature_interface.md §3.

export function createSettingsFeature(nodeServer: NodeServer | null): Feature<SettingsOps> {
    return {
        descriptor: {
            id: "settings",
            name: "Settings",
            description: "Control-plane configuration (domain, OIDC issuer URL) and self-update.",
            experimental: false,
        },
        apiHandlers() {
            return settingsApiHandlers(nodeServer);
        },
    };
}

export type SettingsOps = "getConfig" | "setDomain" | "setIssuerUrl"
    | "getControlPlaneStatus" | "updateControlPlane";

export function settingsApiHandlers(nodeServer: NodeServer | null): FeatureApiHandlers<SettingsOps> {
    return {
        async handleGetConfig(): Promise<{ domain: string | null; issuerUrl: string | null }> {
            const config = await readConfig();
            return { domain: config.domain ?? null, issuerUrl: config.issuerUrl ?? null };
        },

        async handleSetDomain(data: { domain: string | null }): Promise<void> {
            await persistSetDomain(data.domain);
            // Re-issue the leaf so it carries the new domain in its SAN; agents trust the
            // CA, so this takes effect without re-enrolling anything.
            await nodeServer?.refreshTls();
        },

        async handleSetIssuerUrl(data: { issuerUrl: string | null }): Promise<void> {
            if (data.issuerUrl) {
                try {
                    new URL(data.issuerUrl);
                } catch {
                    throw new Error("Issuer URL must be a valid absolute URL");
                }
            }
            await persistSetIssuerUrl(data.issuerUrl);
        },

        async handleGetControlPlaneStatus(): Promise<{ version: string; installed: boolean; latestVersion: string | null; updateAvailable: boolean }> {
            return controlPlaneStatus();
        },

        async handleUpdateControlPlane(): Promise<void> {
            console.log(`[update] control-plane self-update requested (current ${AGENT_VERSION})`);
            await updateControlPlane();
        },
    };
}
