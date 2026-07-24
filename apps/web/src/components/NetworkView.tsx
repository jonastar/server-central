import { useCallback, useEffect, useState } from "react";
import type { NetworkInfo, NetworkInterface } from "@central/shared";
import { api } from "../api";
import { useConnection } from "../hooks/useConnection";
import { cx } from "../utils";
import { EmptyState, ErrorBanner } from "./ui";
import shared from "../styles/shared.module.css";

const REFRESH_MS = 15_000;

function stateBadge(state: string): "badge-ok" | "badge-err" | "badge-warn" {
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
        <section className={shared.panel}>
            <h3>
                {iface.name}{" "}
                <span className={cx(shared.badge, shared[stateBadge(iface.state)])}>{iface.state}</span>
            </h3>
            <div className={shared["info-chips"]}>
                {iface.mac && <span className={shared["info-chip"]}><span className={shared["info-chip-label"]}>MAC</span><span className={cx(shared["info-chip-value"], shared.mono)}>{iface.mac}</span></span>}
                {iface.mtu > 0 && <span className={shared["info-chip"]}><span className={shared["info-chip-label"]}>MTU</span><span className={shared["info-chip-value"]}>{iface.mtu}</span></span>}
            </div>
            {iface.addresses.length === 0 ? (
                <EmptyState>No addresses.</EmptyState>
            ) : (
                <table className={shared["data-table"]}>
                    <thead><tr><th>Family</th><th>Address</th><th>Scope</th></tr></thead>
                    <tbody>
                        {iface.addresses.map((a) => (
                            <tr key={`${a.family}-${a.address}`}>
                                <td className={shared.dim}>{a.family === "inet" ? "IPv4" : a.family === "inet6" ? "IPv6" : a.family}</td>
                                <td className={shared.mono}>{a.address}/{a.prefixlen}</td>
                                <td className={shared.dim}>{a.scope}</td>
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

    // Latest per-node STUN check (a `find_wan_ip` task run targeted at this server).
    const { tasks } = useConnection();
    const stunRun = tasks.find((t) => t.target === serverId && t.spec.kind === "find_wan_ip");
    const stunInFlight = stunRun?.status === "pending" || stunRun?.status === "running";

    async function checkStun() {
        try {
            await api("runTask", { spec: { kind: "find_wan_ip" }, target: serverId });
        } catch { /* surfaced via the run's failed status */ }
    }

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
        <div className={shared.view}>
            <header className={shared["view-header"]}>
                <h1>Network</h1>
                <button className={shared.btn} onClick={() => void load()}>Refresh</button>
            </header>

            {error && <ErrorBanner>{error}</ErrorBanner>}
            {net === null && !error && <EmptyState>Loading…</EmptyState>}
            {net && !net.available && (
                <EmptyState>Network info is not available on this server{net.error ? `: ${net.error}` : "."}</EmptyState>
            )}

            {net?.available && (
                <>
                    <div className={shared["info-chips"]}>
                        <span className={shared["info-chip"]}>
                            <span className={shared["info-chip-label"]}>Remote IP (seen by control plane)</span>
                            <span className={cx(shared["info-chip-value"], shared.mono)}>{net.remoteIp ?? "— (embedded host)"}</span>
                        </span>
                        <span className={shared["info-chip"]}>
                            <span className={shared["info-chip-label"]}>STUN (seen by this node)</span>
                            <span className={cx(shared["info-chip-value"], shared.mono)}>
                                {stunRun && !stunInFlight
                                    ? (stunRun.status === "failed"
                                        ? `Failed: ${stunRun.error ?? "unknown error"}`
                                        : (stunRun.result?.kind === "find_wan_ip" ? stunRun.result.ip ?? "not detected" : "—"))
                                    : "—"}
                            </span>
                        </span>
                        <button className={shared.btn} type="button" disabled={stunInFlight} onClick={() => void checkStun()}>
                            {stunInFlight ? "Checking…" : "Check STUN"}
                        </button>
                    </div>

                    {net.interfaces.map((iface) => (
                        <InterfaceCard key={iface.name} iface={iface} />
                    ))}

                    <section className={shared.panel}>
                        <h3>Routes ({net.routes.length})</h3>
                        {net.routes.length === 0 ? (
                            <EmptyState>No routes.</EmptyState>
                        ) : (
                            <table className={shared["data-table"]}>
                                <thead><tr><th>Destination</th><th>Gateway</th><th>Interface</th><th>Source</th><th>Protocol</th></tr></thead>
                                <tbody>
                                    {net.routes.map((r, i) => (
                                        <tr key={`${r.dst}-${r.dev}-${i}`}>
                                            <td className={shared.mono}>{r.dst}</td>
                                            <td className={cx(shared.mono, shared.dim)}>{r.gateway ?? "—"}</td>
                                            <td>{r.dev}</td>
                                            <td className={cx(shared.mono, shared.dim)}>{r.src ?? "—"}</td>
                                            <td className={shared.dim}>{r.protocol ?? "—"}</td>
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
