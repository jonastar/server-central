import { Fragment, useCallback, useEffect, useState } from "react";
import type { ZfsDevice, ZfsHealth, ZfsPool, ZfsState, ZfsVdev } from "@central/shared";
import { api } from "../../api";
import { runTaskAndWait } from "../../taskRun";
import { cx, fmtBytes } from "../../utils";
import { ConfirmDangerModal, EmptyState, ErrorBanner } from "../ui";
import { CreatePoolModal, AddVdevModal, ReplaceDeviceModal } from "./PoolWizards";
import shared from "../../styles/shared.module.css";

const REFRESH_MS = 15_000;

function healthTone(state: ZfsHealth): "ok" | "warn" | "err" {
    if (state === "ONLINE") {
        return "ok";
    }
    if (state === "DEGRADED" || state === "OFFLINE") {
        return "warn";
    }
    return "err";
}

function scanLabel(pool: ZfsPool): string | null {
    const scan = pool.scan;
    if (!scan) {
        return null;
    }
    const kind = scan.kind === "scrub" ? "Scrub" : "Resilver";
    if (scan.state === "in_progress") {
        const pct = scan.pctDone !== undefined ? ` ${scan.pctDone.toFixed(1)}%` : "";
        const eta = scan.eta ? `, ${scan.eta} left` : "";
        return `${kind} in progress${pct}${eta}`;
    }
    if (scan.state === "cancelled") {
        return `${kind} cancelled`;
    }
    return `${kind} completed${scan.finishedAt ? ` ${new Date(scan.finishedAt).toLocaleString()}` : ""}`;
}

function VdevTree({ vdevs }: { vdevs: ZfsVdev[] }) {
    return (
        <div className={shared["detail-list"]}>
            {vdevs.map((v, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                    <div>
                        <span className={cx(shared.badge, shared[`badge-${healthTone(v.state)}`])}>{v.state}</span>{" "}
                        <b>{v.type}</b>
                    </div>
                    <ul style={{ margin: "4px 0 0 20px", padding: 0 }}>
                        {v.devices.map((d) => (
                            <DeviceRow key={d.name} device={d} />
                        ))}
                    </ul>
                </div>
            ))}
        </div>
    );
}

function DeviceRow({ device }: { device: ZfsDevice }) {
    const errored = device.readErrors > 0 || device.writeErrors > 0 || device.checksumErrors > 0;
    return (
        <li className={cx(shared.mono, shared.dim)} style={{ listStyle: "none", padding: "2px 0" }}>
            <span className={cx(shared.badge, shared[`badge-${healthTone(device.state)}`])}>{device.state}</span>{" "}
            {device.name}
            {errored && (
                <span className={shared.dim}> — R:{device.readErrors} W:{device.writeErrors} CKSUM:{device.checksumErrors}</span>
            )}
        </li>
    );
}

export function ZfsPools({ serverId }: { serverId: string }) {
    const [state, setState] = useState<ZfsState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busyPool, setBusyPool] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [destroyTarget, setDestroyTarget] = useState<ZfsPool | null>(null);
    const [addVdevTo, setAddVdevTo] = useState<string | null>(null);
    const [replaceIn, setReplaceIn] = useState<{ pool: string; device: string } | null>(null);

    const load = useCallback(async () => {
        try {
            setState(await api("zfs", "getState", { serverId }));
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [serverId]);

    useEffect(() => {
        setState(null);
        void load();
        const timer = setInterval(() => void load(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [load]);

    async function scrub(pool: ZfsPool, action: "start" | "stop") {
        setBusyPool(pool.name);
        setError(null);
        try {
            await runTaskAndWait({ kind: "zfs_scrub", pool: pool.name, action }, serverId);
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyPool(null);
        }
    }

    async function exportPool(pool: ZfsPool) {
        if (!confirm(`Export pool "${pool.name}"? It will detach from this host until re-imported.`)) {
            return;
        }
        setBusyPool(pool.name);
        setError(null);
        try {
            await runTaskAndWait({ kind: "zfs_pool_export", name: pool.name }, serverId);
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyPool(null);
        }
    }

    async function doDestroy() {
        if (!destroyTarget) {
            return;
        }
        setBusyPool(destroyTarget.name);
        setError(null);
        try {
            await runTaskAndWait({ kind: "zfs_pool_destroy", name: destroyTarget.name }, serverId, { feedback: "modal" });
            setDestroyTarget(null);
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyPool(null);
        }
    }

    return (
        <div>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            {state === null && !error && <EmptyState>Loading…</EmptyState>}
            {state && !state.available && (
                <EmptyState>ZFS is not available on this server{state.error ? `: ${state.error}` : "."}</EmptyState>
            )}

            {state?.available && (
                <section className={shared.panel}>
                    <div className={shared["panel-head"]}>
                        <h3>Pools ({state.pools.length})</h3>
                        <button className={cx(shared.btn, shared["btn-primary"])} onClick={() => setCreating(true)}>Create pool</button>
                    </div>
                    {state.pools.length === 0 ? (
                        <EmptyState>No pools.</EmptyState>
                    ) : (
                        <table className={shared["data-table"]}>
                            <thead>
                                <tr>
                                    <th className={shared["col-expander"]} />
                                    <th>Pool</th>
                                    <th>Health</th>
                                    <th>Capacity</th>
                                    <th>Free</th>
                                    <th>Frag</th>
                                    <th>Scan</th>
                                </tr>
                            </thead>
                            <tbody>
                                {state.pools.map((pool) => {
                                    const isExpanded = expanded === pool.name;
                                    const busy = busyPool === pool.name;
                                    return (
                                        <Fragment key={pool.name}>
                                            <tr
                                                className={cx(shared["row-clickable"], shared[`row-status-${healthTone(pool.state)}`], busy && shared["row-busy"], isExpanded && shared["row-active"])}
                                                onClick={() => setExpanded(isExpanded ? null : pool.name)}
                                            >
                                                <td className={shared["col-expander"]}><span className={cx(shared["row-expander"], isExpanded && shared.open)}>▸</span></td>
                                                <td><b>{pool.name}</b></td>
                                                <td><span className={cx(shared.badge, shared[`badge-${healthTone(pool.state)}`])}>{pool.state}</span></td>
                                                <td className={shared.dim}>{pool.capacityPct}%</td>
                                                <td className={shared.dim}>{fmtBytes(pool.freeBytes)}</td>
                                                <td className={shared.dim}>{pool.fragmentationPct}%</td>
                                                <td className={shared.dim}>{scanLabel(pool) ?? "—"}</td>
                                            </tr>
                                            {isExpanded && (
                                                <tr className={shared["row-detail-tr"]}>
                                                    <td />
                                                    <td colSpan={6}>
                                                        <div className={shared["row-detail-wrap"]}><div className={shared["row-detail"]}>
                                                            <div className={shared["row-detail-actions"]}>
                                                                {pool.scan?.state === "in_progress" && pool.scan.kind === "scrub" ? (
                                                                    <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy} onClick={() => void scrub(pool, "stop")}>Stop scrub</button>
                                                                ) : (
                                                                    <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy} onClick={() => void scrub(pool, "start")}>Scrub</button>
                                                                )}
                                                                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy} onClick={() => setAddVdevTo(pool.name)}>Add vdev</button>
                                                                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy} onClick={() => void exportPool(pool)}>Export</button>
                                                                <button className={cx(shared.btn, shared["btn-sm"], shared["btn-danger"])} disabled={busy} onClick={() => setDestroyTarget(pool)}>Destroy</button>
                                                            </div>
                                                            <div className={shared["row-detail-body"]}>
                                                                <VdevTree vdevs={pool.vdevs} />
                                                                <p className={shared.dim} style={{ marginTop: 8 }}>{pool.errors}</p>
                                                                <p className={shared.dim} style={{ fontSize: 12 }}>
                                                                    Click a device below to replace it.{" "}
                                                                    {pool.vdevs.flatMap((v) => v.devices).map((d) => (
                                                                        <button
                                                                            key={d.name}
                                                                            className={cx(shared.btn, shared["btn-sm"])}
                                                                            style={{ marginRight: 6, marginTop: 4 }}
                                                                            onClick={() => setReplaceIn({ pool: pool.name, device: d.name })}
                                                                        >
                                                                            Replace {d.name}
                                                                        </button>
                                                                    ))}
                                                                </p>
                                                            </div>
                                                        </div></div>
                                                    </td>
                                                </tr>
                                            )}
                                        </Fragment>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </section>
            )}

            {creating && (
                <CreatePoolModal
                    serverId={serverId}
                    onClose={() => setCreating(false)}
                    onCreated={() => { setCreating(false); void load(); }}
                />
            )}

            {addVdevTo && (
                <AddVdevModal
                    serverId={serverId}
                    pool={addVdevTo}
                    onClose={() => setAddVdevTo(null)}
                    onAdded={() => { setAddVdevTo(null); void load(); }}
                />
            )}

            {replaceIn && (
                <ReplaceDeviceModal
                    serverId={serverId}
                    pool={replaceIn.pool}
                    oldDevice={replaceIn.device}
                    onClose={() => setReplaceIn(null)}
                    onReplaced={() => { setReplaceIn(null); void load(); }}
                />
            )}

            {destroyTarget && (
                <ConfirmDangerModal
                    title={`Destroy pool "${destroyTarget.name}"`}
                    confirmWord={destroyTarget.name}
                    actionLabel="Destroy pool"
                    busy={busyPool === destroyTarget.name}
                    onConfirm={doDestroy}
                    onClose={() => setDestroyTarget(null)}
                >
                    <p style={{ marginTop: 0 }}>
                        This permanently destroys every dataset, snapshot, and file on <b>{destroyTarget.name}</b>.
                        There is no undo.
                    </p>
                </ConfirmDangerModal>
            )}
        </div>
    );
}
