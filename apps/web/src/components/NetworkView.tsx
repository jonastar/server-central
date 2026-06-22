import { useCallback, useEffect, useState } from "react";
import type { NetworkInfo, NetworkInterface } from "@central/shared";
import { api } from "../api";
import { cx } from "../utils";
import { EmptyState, ErrorBanner } from "./ui";

const REFRESH_MS = 15_000;

function stateBadge(state: string): string {
    if (state === "UP") {
        return "badge-ok";
    }
    if (state === "DOWN") {
        return "badge-err";
    }
    return "badge-warn";
}

function InterfaceCard({ iface }: { iface: NetworkInterface }) {
    return (
        <section className="panel">
            <h3>
                {iface.name}{" "}
                <span className={cx("badge", stateBadge(iface.state))}>{iface.state}</span>
            </h3>
            <div className="info-chips">
                {iface.mac && <span className="info-chip"><span className="info-chip-label">MAC</span><span className="info-chip-value mono">{iface.mac}</span></span>}
                {iface.mtu > 0 && <span className="info-chip"><span className="info-chip-label">MTU</span><span className="info-chip-value">{iface.mtu}</span></span>}
            </div>
            {iface.addresses.length === 0 ? (
                <EmptyState>No addresses.</EmptyState>
            ) : (
                <table className="data-table">
                    <thead><tr><th>Family</th><th>Address</th><th>Scope</th></tr></thead>
                    <tbody>
                        {iface.addresses.map((a) => (
                            <tr key={`${a.family}-${a.address}`}>
                                <td className="dim">{a.family === "inet" ? "IPv4" : a.family === "inet6" ? "IPv6" : a.family}</td>
                                <td className="mono">{a.address}/{a.prefixlen}</td>
                                <td className="dim">{a.scope}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    );
}

export function NetworkView({ serverId }: { serverId: string }) {
    const [net, setNet] = useState<NetworkInfo | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setNet(await api("getNetworkInfo", { serverId }));
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [serverId]);

    useEffect(() => {
        setNet(null);
        void load();
        const timer = setInterval(() => void load(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [load]);

    return (
        <div className="view">
            <header className="view-header">
                <h1>Network</h1>
                <button className="btn" onClick={() => void load()}>Refresh</button>
            </header>

            {error && <ErrorBanner>{error}</ErrorBanner>}
            {net === null && !error && <EmptyState>Loading…</EmptyState>}
            {net && !net.available && (
                <EmptyState>Network info is not available on this server{net.error ? `: ${net.error}` : "."}</EmptyState>
            )}

            {net?.available && (
                <>
                    <div className="info-chips">
                        <span className="info-chip">
                            <span className="info-chip-label">Remote IP (seen by control plane)</span>
                            <span className="info-chip-value mono">{net.remoteIp ?? "— (embedded host)"}</span>
                        </span>
                    </div>

                    {net.interfaces.map((iface) => (
                        <InterfaceCard key={iface.name} iface={iface} />
                    ))}

                    <section className="panel">
                        <h3>Routes ({net.routes.length})</h3>
                        {net.routes.length === 0 ? (
                            <EmptyState>No routes.</EmptyState>
                        ) : (
                            <table className="data-table">
                                <thead><tr><th>Destination</th><th>Gateway</th><th>Interface</th><th>Source</th><th>Protocol</th></tr></thead>
                                <tbody>
                                    {net.routes.map((r, i) => (
                                        <tr key={`${r.dst}-${r.dev}-${i}`}>
                                            <td className="mono">{r.dst}</td>
                                            <td className="mono dim">{r.gateway ?? "—"}</td>
                                            <td>{r.dev}</td>
                                            <td className="mono dim">{r.src ?? "—"}</td>
                                            <td className="dim">{r.protocol ?? "—"}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </section>
                </>
            )}
        </div>
    );
}
