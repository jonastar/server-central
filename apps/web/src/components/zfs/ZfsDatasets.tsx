import { Fragment, useCallback, useEffect, useState } from "react";
import type { ZfsDataset } from "@central/shared";
import { api } from "../../api";
import { runTaskAndWait } from "../../taskRun";
import { cx, fmtBytes } from "../../utils";
import { ConfirmDangerModal, EmptyState, ErrorBanner, Modal } from "../ui";
import shared from "../../styles/shared.module.css";

const REFRESH_MS = 15_000;
const COMMON_PROPS = ["compression", "quota", "recordsize", "atime", "readonly", "mountpoint", "canmount"];

function CreateDatasetModal({ serverId, datasets, onClose, onCreated }: {
    serverId: string;
    datasets: ZfsDataset[];
    onClose: () => void;
    onCreated: () => void;
}) {
    const pools = [...new Set(datasets.map((d) => d.pool))];
    const [parent, setParent] = useState(datasets[0]?.pool ?? pools[0] ?? "");
    const [name, setName] = useState("");
    const [type, setType] = useState<"filesystem" | "volume">("filesystem");
    const [volsizeGb, setVolsizeGb] = useState("10");
    const [compression, setCompression] = useState("");
    const [quotaGb, setQuotaGb] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            const properties: Record<string, string> = {};
            if (compression) {
                properties.compression = compression;
            }
            if (quotaGb) {
                properties.quota = `${quotaGb}G`;
            }
            await runTaskAndWait({
                kind: "zfs_dataset_create",
                parent,
                name,
                type,
                volsizeBytes: type === "volume" ? Math.round(Number(volsizeGb) * 1024 ** 3) : undefined,
                properties,
            }, serverId, { feedback: "modal" });
            onCreated();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="Create dataset" onClose={onClose} width={480}>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            <label className={shared["login-field"]}>
                <span>Parent</span>
                <select value={parent} onChange={(e) => setParent(e.target.value)}>
                    {[...new Set(datasets.map((d) => d.name).concat(pools))].sort().map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
            </label>
            <label className={shared["login-field"]}>
                <span>Name</span>
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="media" />
            </label>
            <label className={shared["login-field"]}>
                <span>Type</span>
                <select value={type} onChange={(e) => setType(e.target.value as "filesystem" | "volume")}>
                    <option value="filesystem">Filesystem</option>
                    <option value="volume">Volume (zvol)</option>
                </select>
            </label>
            {type === "volume" && (
                <label className={shared["login-field"]}>
                    <span>Size (GB)</span>
                    <input type="number" min="1" value={volsizeGb} onChange={(e) => setVolsizeGb(e.target.value)} />
                </label>
            )}
            <label className={shared["login-field"]}>
                <span>Compression (optional)</span>
                <select value={compression} onChange={(e) => setCompression(e.target.value)}>
                    <option value="">(inherit)</option>
                    <option value="lz4">lz4</option>
                    <option value="zstd">zstd</option>
                    <option value="off">off</option>
                </select>
            </label>
            <label className={shared["login-field"]}>
                <span>Quota GB (optional)</span>
                <input type="number" min="0" value={quotaGb} onChange={(e) => setQuotaGb(e.target.value)} placeholder="none" />
            </label>
            <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                <button className={cx(shared.btn, shared["btn-primary"])} type="button" disabled={busy || !name || !parent} onClick={submit}>
                    {busy ? "Creating…" : "Create"}
                </button>
            </div>
        </Modal>
    );
}

function SetPropertyModal({ serverId, dataset, onClose, onSet }: {
    serverId: string;
    dataset: ZfsDataset;
    onClose: () => void;
    onSet: () => void;
}) {
    const [key, setKey] = useState("compression");
    const [customKey, setCustomKey] = useState("");
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const effectiveKey = key === "other" ? customKey : key;

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            await api("setDatasetProperty", { serverId, name: dataset.name, key: effectiveKey, value });
            onSet();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title={`Set property — ${dataset.name}`} onClose={onClose} width={420}>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            <label className={shared["login-field"]}>
                <span>Property</span>
                <select value={key} onChange={(e) => setKey(e.target.value)}>
                    {COMMON_PROPS.map((p) => <option key={p} value={p}>{p}</option>)}
                    <option value="other">other…</option>
                </select>
            </label>
            {key === "other" && (
                <label className={shared["login-field"]}>
                    <span>Property name</span>
                    <input autoFocus value={customKey} onChange={(e) => setCustomKey(e.target.value)} />
                </label>
            )}
            <label className={shared["login-field"]}>
                <span>Value</span>
                <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. lz4, 10G, off" />
            </label>
            <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                <button className={cx(shared.btn, shared["btn-primary"])} type="button" disabled={busy || !effectiveKey || !value} onClick={submit}>
                    {busy ? "Setting…" : "Set"}
                </button>
            </div>
        </Modal>
    );
}

export function ZfsDatasets({ serverId }: { serverId: string }) {
    const [datasets, setDatasets] = useState<ZfsDataset[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState("");
    const [busyName, setBusyName] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [editingProps, setEditingProps] = useState<ZfsDataset | null>(null);
    const [destroyTarget, setDestroyTarget] = useState<ZfsDataset | null>(null);

    const load = useCallback(async () => {
        try {
            setDatasets(await api("getZfsDatasets", { serverId }));
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [serverId]);

    useEffect(() => {
        setDatasets(null);
        void load();
        const timer = setInterval(() => void load(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [load]);

    async function snapshotNow(ds: ZfsDataset) {
        const defaultName = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
        const name = prompt(`Snapshot name for ${ds.name}`, defaultName);
        if (!name) {
            return;
        }
        setBusyName(ds.name);
        setError(null);
        try {
            await runTaskAndWait({ kind: "zfs_snapshot_create", dataset: ds.name, name, recursive: false }, serverId);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyName(null);
        }
    }

    async function doDestroy(recursive: boolean) {
        if (!destroyTarget) {
            return;
        }
        setBusyName(destroyTarget.name);
        setError(null);
        try {
            await runTaskAndWait({ kind: "zfs_dataset_destroy", name: destroyTarget.name, recursive }, serverId, { feedback: "modal" });
            setDestroyTarget(null);
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusyName(null);
        }
    }

    const shown = (datasets ?? []).filter((d) => !filter || d.name.toLowerCase().includes(filter.toLowerCase()));

    return (
        <div>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            {datasets === null && !error && <EmptyState>Loading…</EmptyState>}

            {datasets && (
                <section className={shared.panel}>
                    <div className={shared["panel-head"]}>
                        <h3>Datasets ({shown.length})</h3>
                        <input
                            className={shared["filter-input"]}
                            placeholder="Filter by name…"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                        />
                        <button className={cx(shared.btn, shared["btn-primary"])} onClick={() => setCreating(true)}>Create dataset</button>
                    </div>
                    {shown.length === 0 ? (
                        <EmptyState>No datasets.</EmptyState>
                    ) : (
                        <table className={shared["data-table"]}>
                            <thead>
                                <tr>
                                    <th className={shared["col-expander"]} />
                                    <th>Name</th>
                                    <th>Type</th>
                                    <th>Used</th>
                                    <th>Available</th>
                                    <th>Mountpoint</th>
                                    <th>Compression</th>
                                </tr>
                            </thead>
                            <tbody>
                                {shown.map((ds) => {
                                    const isExpanded = expanded === ds.name;
                                    const busy = busyName === ds.name;
                                    return (
                                        <Fragment key={ds.name}>
                                            <tr
                                                className={cx(shared["row-clickable"], busy && shared["row-busy"], isExpanded && shared["row-active"])}
                                                onClick={() => setExpanded(isExpanded ? null : ds.name)}
                                            >
                                                <td className={shared["col-expander"]}><span className={cx(shared["row-expander"], isExpanded && shared.open)}>▸</span></td>
                                                <td className={shared.mono}>{ds.name}</td>
                                                <td className={shared.dim}>{ds.type}</td>
                                                <td className={shared.dim}>{fmtBytes(ds.usedBytes)}</td>
                                                <td className={shared.dim}>{fmtBytes(ds.availBytes)}</td>
                                                <td className={shared.dim}>{ds.mountpoint ?? "—"}</td>
                                                <td className={shared.dim}>{ds.compression} ({ds.compressRatio.toFixed(2)}x)</td>
                                            </tr>
                                            {isExpanded && (
                                                <tr className={shared["row-detail-tr"]}>
                                                    <td />
                                                    <td colSpan={6}>
                                                        <div className={shared["row-detail-wrap"]}><div className={shared["row-detail"]}>
                                                            <div className={shared["row-detail-actions"]}>
                                                                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy} onClick={() => void snapshotNow(ds)}>Snapshot now</button>
                                                                <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy} onClick={() => setEditingProps(ds)}>Set property</button>
                                                                <button className={cx(shared.btn, shared["btn-sm"], shared["btn-danger"])} disabled={busy} onClick={() => setDestroyTarget(ds)}>Destroy</button>
                                                            </div>
                                                            <div className={shared["detail-grid"]}>
                                                                <div><span className={shared.dim}>Refer</span> {fmtBytes(ds.referBytes)}</div>
                                                                <div><span className={shared.dim}>Quota</span> {ds.quotaBytes ? fmtBytes(ds.quotaBytes) : "none"}</div>
                                                                <div><span className={shared.dim}>Mounted</span> {ds.mounted ? "yes" : "no"}</div>
                                                                <div>
                                                                    <span className={shared.dim}>Auto-mount</span>{" "}
                                                                    <span className={cx(shared.badge, shared[ds.canmount === "on" ? "badge-ok" : "badge-warn"])}>{ds.canmount}</span>
                                                                </div>
                                                                {ds.recordsize !== undefined && <div><span className={shared.dim}>Recordsize</span> {fmtBytes(ds.recordsize)}</div>}
                                                                {ds.volsizeBytes !== undefined && <div><span className={shared.dim}>Volsize</span> {fmtBytes(ds.volsizeBytes)}</div>}
                                                                {ds.origin && <div><span className={shared.dim}>Origin (clone of)</span> {ds.origin}</div>}
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
                <CreateDatasetModal
                    serverId={serverId}
                    datasets={datasets ?? []}
                    onClose={() => setCreating(false)}
                    onCreated={() => { setCreating(false); void load(); }}
                />
            )}

            {editingProps && (
                <SetPropertyModal
                    serverId={serverId}
                    dataset={editingProps}
                    onClose={() => setEditingProps(null)}
                    onSet={() => { setEditingProps(null); void load(); }}
                />
            )}

            {destroyTarget && (
                <ConfirmDangerModal
                    title={`Destroy dataset "${destroyTarget.name}"`}
                    confirmWord={destroyTarget.name}
                    actionLabel="Destroy dataset"
                    busy={busyName === destroyTarget.name}
                    onConfirm={() => void doDestroy(true)}
                    onClose={() => setDestroyTarget(null)}
                >
                    <p style={{ marginTop: 0 }}>
                        This permanently destroys <b>{destroyTarget.name}</b> and every child dataset and
                        snapshot beneath it. There is no undo.
                    </p>
                </ConfirmDangerModal>
            )}
        </div>
    );
}
