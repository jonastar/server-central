import type { NetworkAddress, NetworkInfo, NetworkInterface, NetworkRoute } from "@central/shared";
import type { HostAgent } from "./host-agent";

// iproute2's JSON output (`ip -j`), the rows we care about.
interface IpAddrRow {
    ifname: string;
    address?: string;
    operstate?: string;
    mtu?: number;
    addr_info?: Array<{ family: string; local?: string; prefixlen?: number; scope?: string }>;
}
interface IpRouteRow {
    dst: string;
    gateway?: string;
    dev: string;
    protocol?: string;
    prefsrc?: string;
}

function parseJson<T>(text: string): T | null {
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

/**
 * Collect the host's network adapters, addresses, and routes via iproute2's JSON
 * output (`ip -j addr` / `ip -j route`). `remoteIp` (the agent's source IP as seen
 * by the control plane) is supplied by the caller, mirroring how the control plane
 * discovers its own WAN IP.
 */
export async function getNetworkInfo(server: HostAgent): Promise<NetworkInfo> {
    const remoteIp = server.remoteIp;

    const addr = await server.exec("ip -j addr 2>&1");
    const rows = addr.code === 0 ? parseJson<IpAddrRow[]>(addr.stdout) : null;
    if (!rows) {
        return {
            available: false,
            error: (addr.stdout || "`ip -j addr` unavailable").trim().split("\n")[0],
            interfaces: [],
            routes: [],
            remoteIp,
        };
    }

    const interfaces: NetworkInterface[] = rows.map((r) => {
        const addresses: NetworkAddress[] = (r.addr_info ?? [])
            .filter((a) => a.local)
            .map((a) => ({
                family: a.family,
                address: a.local!,
                prefixlen: a.prefixlen ?? 0,
                scope: a.scope ?? "",
            }));
        return {
            name: r.ifname,
            mac: r.address ?? "",
            state: r.operstate ?? "UNKNOWN",
            mtu: r.mtu ?? 0,
            addresses,
        };
    });

    const routeRes = await server.exec("ip -j route 2>&1");
    const routeRows = routeRes.code === 0 ? parseJson<IpRouteRow[]>(routeRes.stdout) : null;
    const routes: NetworkRoute[] = (routeRows ?? []).map((r) => ({
        dst: r.dst,
        gateway: r.gateway,
        dev: r.dev,
        protocol: r.protocol,
        src: r.prefsrc,
    }));

    return { available: true, interfaces, routes, remoteIp };
}
