import { useCallback, useEffect, useState } from "react";
import type { ZfsSnapshot } from "@central/shared";
import { api } from "../../api";
import { runTaskAndWait } from "../../taskRun";
import { cx, fmtBytes, fmtDateTime } from "../../utils";
import { ConfirmDangerModal, EmptyState, ErrorBanner, Modal } from "../ui";
import shared from "../../styles/shared.module.css";

const REFRESH_MS = 15_000;

function CreateSnapshotModal({ serverId, onClose, onCreated }: {
    serverId: string;
    onClose: () => void;
    onCreated: () => void;
}) {
    const [datasets, setDatasets] = useState<string[] | null>(null);
    const [dataset, setDataset] = useState("");
    const [name, setName] = useState(() => new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19));
    const [recursive, setRecursive] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        api("getZfsDatasets", { serverId })
            .then((ds) => { setDatasets(ds.map((d) => d.name)); setDataset(ds[0]?.name ?? ""); })
            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, [serverId]);

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            await runTaskAndWait({ kind: "zfs_snapshot_create", dataset, name, recursive }, serverId);
            onCreated();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="Create snapshot" onClose={onClose} width={420}>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            <label className={shared["login-field"]}>
                <span>Dataset</span>
                {datasets ? (
                    <select value={dataset} onChange={(e) => setDataset(e.target.value)}>
                        {datasets.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                ) : (
                    <input disabled value="Loading…" />
                )}
            </label>
            <label className={shared["login-field"]}>
                <span>Snapshot name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className={shared["login-field"]} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} style={{ width: "auto" }} />
                <span>Include child datasets (recursive)</span>
            </label>
            <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                <button className={cx(shared.btn, shared["btn-primary"])} type="button" disabled={busy || !dataset || !name} onClick={submit}>
                    {busy ? "Creating…" : "Create"}
                </button>
            </div>
        </Modal>
    );
}

function CloneModal({ serverId, snapshot, onClose, onCloned }: {
    serverId: string;
    snapshot: ZfsSnapshot;
    onClose: () => void;
    onCloned: () => void;
}) {
    const [target, setTarget] = useState(`${snapshot.dataset}-clone`);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            await runTaskAndWait({ kind: "zfs_snapshot_clone", snapshot: snapshot.name, target }, serverId);
            onCloned();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title={`Clone ${snapshot.name}`} onClose={onClose} width={420}>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            <label className={shared["login-field"]}>
                <span>New dataset name</span>
                <input autoFocus value={target} onChange={(e) => setTarget(e.target.value)} />
            </label>
            <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                <button className={cx(shared.btn, shared["btn-primary"])} type="button" disabled={busy || !target} onClick={submit}>
                    {busy ? "Cloning…" : "Clone"}
                </button>
            </div>
        </Modal>
    );
}

export function ZfsSnapshots({ serverId }: { serverId: string }) {
    const [snapshots, setSnapshots] = useState<ZfsSnapshot[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState("");
    const [busyName, setBusyName] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [cloning, setCloning] = useState<ZfsSnapshot | null>(null);
    const [destroyTarget, setDestroyTarget] = useState<ZfsSnapshot | null>(null);
    const [rollbackTarget, setRollbackTarget] = useState<ZfsSnapshot | null>(null);

    const load = useCallback(async () => {
        try {
            setSnapshots(await api("getZfsSnapshots", { serverId }));
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [serverId]);

    useEffect(() => {
        setSnapshots(null);
        void load();
        const timer = setInterval(() => void load(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [load]);

    async function doDestroy() {
        if (!destroyTarget) {
            return;
        }
        setBusyName(destroyTarget.name);
        setError(null);
        try {
            await runTaskAndWait({ kind: "zfs_snapshot_destroy", snapshot: destroyTarget.name }, serverId);
            setDestroyTarget(null);
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyName(null);
        }
    }

    async function doRollback() {
        if (!rollbackTarget || !snapshots) {
            return;
        }
        const newerCount = snapshots.filter((s) => s.dataset === rollbackTarget.dataset && s.createdAt > rollbackTarget.createdAt).length;
        setBusyName(rollbackTarget.name);
        setError(null);
        try {
            await runTaskAndWait({ kind: "zfs_snapshot_rollback", snapshot: rollbackTarget.name, destroyLater: newerCount > 0 }, serverId, { feedback: "modal" });
            setRollbackTarget(null);
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyName(null);
        }
    }

    const shown = (snapshots ?? [])
        .filter((s) => !filter || s.name.toLowerCase().includes(filter.toLowerCase()))
        .sort((a, b) => b.createdAt - a.createdAt);
    const newerCount = rollbackTarget && snapshots
        ? snapshots.filter((s) => s.dataset === rollbackTarget.dataset && s.createdAt > rollbackTarget.createdAt).length
        : 0;

    return (
        <div>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            {snapshots === null && !error && <EmptyState>Loading…</EmptyState>}

            {snapshots && (
                <section className={shared.panel}>
                    <div className={shared["panel-head"]}>
                        <h3>Snapshots ({shown.length})</h3>
                        <input
                            className={shared["filter-input"]}
                            placeholder="Filter by name…"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                        />
                        <button className={cx(shared.btn, shared["btn-primary"])} onClick={() => setCreating(true)}>Create snapshot</button>
                    </div>
                    {shown.length === 0 ? (
                        <EmptyState>No snapshots.</EmptyState>
                    ) : (
                        <table className={shared["data-table"]}>
                            <thead>
                                <tr>
                                    <th>Snapshot</th>
                                    <th>Created</th>
                                    <th>Used</th>
                                    <th>Refer</th>
                                    <th />
                                </tr>
                            </thead>
                            <tbody>
                                {shown.map((s) => {
                                    const busy = busyName === s.name;
                                    return (
                                        <tr key={s.name} className={cx(busy && shared["row-busy"])}>
                                            <td className={shared.mono}>{s.name}</td>
                                            <td className={shared.dim}>{fmtDateTime(s.createdAt)}</td>
                                            <td className={shared.dim}>{fmtBytes(s.usedBytes)}</td>
                                            <td className={shared.dim}>{fmtBytes(s.referBytes)}</td>
                                            <td className={shared["row-actions-always"]}>
                                                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy} onClick={() => setCloning(s)}>Clone</button>
                                                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy} onClick={() => setRollbackTarget(s)}>Rollback</button>
                                                <button className={cx(shared.btn, shared["btn-sm"], shared["btn-danger"])} disabled={busy} onClick={() => setDestroyTarget(s)}>Destroy</button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </section>
            )}

            {creating && (
                <CreateSnapshotModal serverId={serverId} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void load(); }} />
            )}

            {cloning && (
                <CloneModal serverId={serverId} snapshot={cloning} onClose={() => setCloning(null)} onCloned={() => { setCloning(null); void load(); }} />
            )}

            {destroyTarget && (
                <ConfirmDangerModal
                    title={`Destroy snapshot`}
                    confirmWord={destroyTarget.name}
                    actionLabel="Destroy snapshot"
                    busy={busyName === destroyTarget.name}
                    onConfirm={doDestroy}
                    onClose={() => setDestroyTarget(null)}
                >
                    <p style={{ marginTop: 0 }}>This permanently destroys <b>{destroyTarget.name}</b>. There is no undo.</p>
                </ConfirmDangerModal>
            )}

            {rollbackTarget && (
                <ConfirmDangerModal
                    title={`Rollback to "${rollbackTarget.name}"`}
                    confirmWord={rollbackTarget.dataset}
                    actionLabel="Roll back"
                    busy={busyName === rollbackTarget.name}
                    onConfirm={doRollback}
                    onClose={() => setRollbackTarget(null)}
                >
                    <p style={{ marginTop: 0 }}>
                        This reverts <b>{rollbackTarget.dataset}</b> to its state at {fmtDateTime(rollbackTarget.createdAt)},
                        discarding every write since.
                        {newerCount > 0 && (
                            <> It also permanently destroys <b>{newerCount}</b> newer snapshot{newerCount === 1 ? "" : "s"} on this dataset.</>
                        )}
                    </p>
                </ConfirmDangerModal>
            )}
        </div>
    );
}
