import { AGENT_VERSION } from "@central/shared";
import {
    readConfig,
    setAllowedOrigins as persistSetAllowedOrigins,
    setDomain as persistSetDomain,
    setPrimaryUrl as persistSetPrimaryUrl,
    setTrustedProxies as persistSetTrustedProxies,
} from "../../config";
import { DEFAULT_FORWARDED_HEADER, parseCidr, type TrustedProxyEntry } from "../../client-ip";
import { defineFeature } from "../../feature";
import type { NodeServer } from "../../node-server";
import type { OidcStore } from "../oidc/store";
import { controlPlaneStatus, updateControlPlane } from "../../server-install";

// The control plane's own settings: the three addresses other subsystems read out
// of config.ts, plus its self-update. Config stays one flat file (config.ts)
// rather than a per-feature store — see doc/idea_feature_interface.md §3.
//
// The three are deliberately separate, because they answer different questions and
// only coincide in the simplest deployment:
//   primaryUrl     — where browsers reach SC (also the OIDC issuer)
//   allowedOrigins — which *other* apps may call the API cross-origin
//   domain         — where agents reach the node server on :4142

export const createSettingsFeature = (
    nodeServer: NodeServer | null,
    oidcStore: OidcStore,
    /** Applies a new CORS allowlist to the running server, so the setting takes
     *  effect without a restart (index.ts owns the live value). */
    applyAllowedOrigins: (configured: string[], primaryUrl: string | null) => void,
    /** Same, for the trusted-proxy list. */
    applyTrustedProxies: (configured: TrustedProxyEntry[]) => void,
    /** SC_TRUSTED_PROXIES is set, so the env wins and edits must be refused. */
    trustedProxiesLocked: boolean,
) => defineFeature({
    id: "settings",
    name: "Settings",
    description: "Control-plane configuration (primary URL, allowed origins, agent domain) and self-update.",
    ops: {
        async getConfig() {
            const config = await readConfig();
            return {
                domain: config.domain ?? null,
                primaryUrl: config.primaryUrl ?? null,
                allowedOrigins: config.allowedOrigins ?? [],
                // Flattened to one shape so the UI doesn't branch on the two forms
                // the config file accepts.
                trustedProxies: (config.trustedProxies ?? []).map((entry) => typeof entry === "string"
                    ? { address: entry, header: "" }
                    : { address: entry.address, header: entry.header ?? "" }),
                forwardedHeader: config.forwardedHeader?.trim().toLowerCase() ?? DEFAULT_FORWARDED_HEADER,
                trustedProxiesLocked,
                oidcClientCount: oidcStore.listClients().length,
            };
        },

        async setTrustedProxies(data) {
            if (trustedProxiesLocked) {
                throw new Error("Trusted proxies are set by SC_TRUSTED_PROXIES in the environment, so they can't be changed here");
            }
            const entries: TrustedProxyEntry[] = [];
            for (const { address, header } of data.trustedProxies) {
                const trimmed = address.trim();
                if (!trimmed) {
                    continue;
                }
                if (!parseCidr(trimmed)) {
                    throw new Error(`"${trimmed}" isn't a valid IP address or CIDR range`);
                }
                // Header names are tokens; anything with whitespace or a separator in
                // it can't be one, and would silently never match an incoming header.
                const name = header.trim();
                if (name && !/^[A-Za-z0-9!#$%&\'*+.^_`|~-]+$/.test(name)) {
                    throw new Error(`"${name}" isn't a valid header name`);
                }
                entries.push(name ? { address: trimmed, header: name.toLowerCase() } : trimmed);
            }
            await persistSetTrustedProxies(entries);
            applyTrustedProxies(entries);
        },

        async setDomain(data) {
            await persistSetDomain(data.domain);
            // Re-issue the leaf so it carries the new domain in its SAN; agents trust the
            // CA, so this takes effect without re-enrolling anything.
            await nodeServer?.refreshTls();
        },

        async setPrimaryUrl(data) {
            const config = await readConfig();
            const next = data.primaryUrl ? normalizeUrl(data.primaryUrl, "Primary URL") : null;
            if (next === (config.primaryUrl ?? null)) {
                return;
            }
            // `iss` is baked into every token an OIDC client has already accepted, and
            // clients pin the issuer from discovery — changing it out from under them
            // breaks sign-in with an error that points nowhere near this setting.
            const clients = oidcStore.listClients().length;
            if (clients > 0 && !data.force) {
                // The leading clause is fixed wording: the web UI keys its "change
                // anyway?" confirmation off it, so pluralization must not disturb it.
                throw new Error(
                    `Changing the primary URL will break sign-in for ${clients} SSO client`
                    + `${clients === 1 ? " that trusts" : "s that trust"} it as their token issuer, `
                    + "until they're reconfigured.",
                );
            }
            await persistSetPrimaryUrl(next);
            applyAllowedOrigins(config.allowedOrigins ?? [], next);
        },

        async setAllowedOrigins(data) {
            const normalized: string[] = [];
            for (const entry of data.allowedOrigins) {
                const trimmed = entry.trim();
                if (!trimmed) {
                    continue;
                }
                const origin = trimmed === "*" ? "*" : normalizeUrl(trimmed, "Allowed origin");
                if (!normalized.includes(origin)) {
                    normalized.push(origin);
                }
            }
            await persistSetAllowedOrigins(normalized);
            const config = await readConfig();
            applyAllowedOrigins(normalized, config.primaryUrl ?? null);
        },

        async getControlPlaneStatus() {
            return controlPlaneStatus();
        },

        async updateControlPlane() {
            console.log(`[update] control-plane self-update requested (current ${AGENT_VERSION})`);
            await updateControlPlane();
        },

    },
});


/** Reject anything that isn't an absolute http(s) URL, and normalize it to a bare
 *  origin — a path would silently break the OIDC discovery paths built off it. */
function normalizeUrl(value: string, label: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${label} must be a valid absolute URL, e.g. https://central.example.com`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`${label} must be http or https`);
    }
    if (url.pathname !== "/" || url.search || url.hash) {
        throw new Error(`${label} must be a bare origin, with no path or query`);
    }
    return url.origin;
}

