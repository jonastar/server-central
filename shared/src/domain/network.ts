// ---- Networking --------------------------------------------------------------

export interface NetworkAddress {
    /** "inet" (IPv4) or "inet6" (IPv6). */
    family: string;
    address: string;
    prefixlen: number;
    /** e.g. "global", "host", "link". */
    scope: string;
}

export interface NetworkInterface {
    name: string;
    mac: string;
    /** operstate: "UP" | "DOWN" | "UNKNOWN" | … */
    state: string;
    mtu: number;
    addresses: NetworkAddress[];
}

export interface NetworkRoute {
    /** "default" or a CIDR/destination. */
    dst: string;
    gateway?: string;
    dev: string;
    protocol?: string;
    /** prefsrc — the source address used for this route. */
    src?: string;
}

export interface NetworkInfo {
    available: boolean;
    error?: string;
    interfaces: NetworkInterface[];
    routes: NetworkRoute[];
    /** The agent's source IP as seen by the control plane (its public IP across
     *  NAT). Null for the embedded host. */
    remoteIp: string | null;
}


export interface NetworkOperations {
    /** Adapters, addresses, routes, and the agent's remote IP. */
    getInfo: { data: { serverId: string }; response: NetworkInfo };
}
