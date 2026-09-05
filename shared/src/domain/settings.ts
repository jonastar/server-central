// ---- Settings ------------------------------------------------------------------
//
// Control-plane configuration editable from the Settings view. Everything here is
// applied live where it can be (CORS, trusted proxies) rather than at next boot —
// a control that only takes effect after a restart is a control that looks broken.

/** A proxy whose forwarded client-address header is believed, and the header it
 *  writes (`""` = use the configured default `forwardedHeader`). */
export interface TrustedProxyConfig {
    address: string;
    header: string;
}

export interface ControlPlaneConfig {
    /** Agents' address for the node server (:4142) — not a browser-facing URL. */
    domain: string | null;
    /** Canonical public URL of this control plane; also the OIDC issuer. */
    primaryUrl: string | null;
    /** Other origins allowed to call the API cross-origin. */
    allowedOrigins: string[];
    trustedProxies: TrustedProxyConfig[];
    /** Header used for trusted proxies that don't name one of their own. */
    forwardedHeader: string;
    /** True when SC_TRUSTED_PROXIES is set: the env wins, so the UI must
     *  show the list read-only rather than accept a save it would override. */
    trustedProxiesLocked: boolean;
    /** OIDC clients trusting the current primaryUrl as their `iss`. Non-zero
     *  means changing it breaks them, so the UI warns and `force` is required. */
    oidcClientCount: number;
}

export interface SettingsOperations {
    getConfig: { data: void; response: ControlPlaneConfig };
    setDomain: { data: { domain: string | null }; response: void };
    // The canonical public URL browsers reach this control plane at (e.g.
    // "https://central.example.com"). Doubles as the OIDC `iss` claim and
    // discovery-document base, so it must stay stable once a client trusts it:
    // changing it while OIDC clients exist is refused unless `force` is set.
    setPrimaryUrl: { data: { primaryUrl: string | null; force?: boolean }; response: void };
    // Origins permitted to read API responses cross-origin. This is for *other*
    // apps calling the API — the web UI is same-origin and needs no entry. Empty
    // keeps the permissive `Access-Control-Allow-Origin: *` default.
    setAllowedOrigins: { data: { allowedOrigins: string[] }; response: void };
    // Proxies whose forwarded header is believed when resolving a client IP, each
    // optionally naming the header it writes (empty = the configured default).
    // Refused while SC_TRUSTED_PROXIES is set, since the environment overrides it.
    setTrustedProxies: { data: { trustedProxies: TrustedProxyConfig[] }; response: void };

    // Control plane (the server itself): its running version vs. the latest release,
    // and a self-update that swaps the binary and restarts. updateAvailable is false
    // unless the control plane is installed as a service and a newer release exists.
    getControlPlaneStatus: {
        data: void;
        response: { version: string; installed: boolean; latestVersion: string | null; updateAvailable: boolean };
    };
    updateControlPlane: { data: void; response: void };
}
