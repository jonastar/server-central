import { useEffect, useState } from "react";
import type { ZfsBlockDevice, ZfsVdevType } from "@central/shared";
import { api, runTaskAndWait } from "../../api";
import { cx, fmtBytes } from "../../utils";
import { EmptyState, ErrorBanner, Modal } from "../ui";
import shared from "../../styles/shared.module.css";

const VDEV_TYPES: Array<{ id: ZfsVdevType; label: string; minDevices: number }> = [
    { id: "stripe", label: "Stripe (no redundancy)", minDevices: 1 },
    { id: "mirror", label: "Mirror", minDevices: 2 },
    { id: "raidz1", label: "RAID-Z1", minDevices: 3 },
    { id: "raidz2", label: "RAID-Z2", minDevices: 4 },
    { id: "raidz3", label: "RAID-Z3", minDevices: 5 },
    { id: "log", label: "Log (SLOG)", minDevices: 1 },
    { id: "cache", label: "Cache (L2ARC)", minDevices: 1 },
];

function useBlockDevices(serverId: string) {
    const [devices, setDevices] = useState<ZfsBlockDevice[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        api("getZfsBlockDevices", { serverId })
            .then(setDevices)
            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, [serverId]);
    return { devices, error };
}

function deviceLabel(d: ZfsBlockDevice): string {
    return `${d.name} — ${d.model || "unknown model"} (${fmtBytes(d.sizeBytes)}${d.rotational ? ", HDD" : ", SSD"})`;
}

/** Picks devices for one vdev — disables anything already in use elsewhere in
 *  the pool tree, or already picked for another group in this wizard. Always
 *  submits the /dev/disk/by-id path (never bare /dev/sdX — see doc/idea_zfs.md's
 *  safety model: by-id ordering survives reboots, /dev/sdX doesn't). */
function DeviceMultiSelect({ devices, selected, disabledElsewhere, onToggle }: {
    devices: ZfsBlockDevice[];
    selected: Set<string>;
    disabledElsewhere: Set<string>;
    onToggle: (byIdPath: string) => void;
}) {
    return (
        <div className={shared["detail-list"]} style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
            {devices.map((d) => {
                const byId = d.byIdPaths[0];
                const disabled = !!d.inUse || !byId || (!!byId && disabledElsewhere.has(byId));
                return (
                    <label key={d.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", opacity: disabled ? 0.5 : 1 }}>
                        <input
                            type="checkbox"
                            disabled={disabled}
                            checked={!!byId && selected.has(byId)}
                            onChange={() => byId && onToggle(byId)}
                        />
                        <span className={shared.mono} style={{ fontSize: 12 }}>{deviceLabel(d)}</span>
                        {d.inUse && <span className={cx(shared.badge, shared["badge-warn"])}>{d.inUse}{d.inUseDetail ? `: ${d.inUseDetail}` : ""}</span>}
                        {!byId && <span className={cx(shared.badge, shared["badge-err"])}>no stable by-id path</span>}
                    </label>
                );
            })}
        </div>
    );
}

interface VdevGroup {
    id: number;
    type: ZfsVdevType;
    devices: string[];
}

function VdevGroupEditor({ group, devices, allSelected, onChange, onRemove }: {
    group: VdevGroup;
    devices: ZfsBlockDevice[];
    /** by-id paths picked by every other group, so the same disk can't be double-used. */
    allSelected: Set<string>;
    onChange: (next: VdevGroup) => void;
    onRemove: () => void;
}) {
    const spec = VDEV_TYPES.find((v) => v.id === group.type)!;
    const mySelected = new Set(group.devices);
    const disabledElsewhere = new Set([...allSelected].filter((d) => !mySelected.has(d)));

    return (
        <div className={shared.panel} style={{ marginBottom: 12 }}>
            <div className={shared["panel-head"]}>
                <select
                    value={group.type}
                    onChange={(e) => onChange({ ...group, type: e.target.value as ZfsVdevType, devices: [] })}
                >
                    {VDEV_TYPES.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                </select>
                <span className={shared.dim} style={{ fontSize: 12 }}>needs at least {spec.minDevices}</span>
                <button className={cx(shared.btn, shared["btn-sm"])} style={{ marginLeft: "auto" }} onClick={onRemove}>Remove</button>
            </div>
            <DeviceMultiSelect
                devices={devices}
                selected={mySelected}
                disabledElsewhere={disabledElsewhere}
                onToggle={(byId) => {
                    const next = mySelected.has(byId) ? group.devices.filter((d) => d !== byId) : [...group.devices, byId];
                    onChange({ ...group, devices: next });
                }}
            />
        </div>
    );
}

export function CreatePoolModal({ serverId, onClose, onCreated }: {
    serverId: string;
    onClose: () => void;
    onCreated: () => void;
}) {
    const { devices, error: loadError } = useBlockDevices(serverId);
    const [name, setName] = useState("");
    const [groups, setGroups] = useState<VdevGroup[]>([{ id: 0, type: "mirror", devices: [] }]);
    const [nextId, setNextId] = useState(1);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const allSelected = new Set(groups.flatMap((g) => g.devices));
    const nonRedundant = groups.some((g) => g.type === "stripe");
    const invalid = groups.some((g) => g.devices.length < (VDEV_TYPES.find((v) => v.id === g.type)?.minDevices ?? 1));
    const command = name && groups.some((g) => g.devices.length > 0)
        ? `zpool create ${JSON.stringify(name)} ${groups.filter((g) => g.devices.length).map((g) => `${g.type === "stripe" ? "" : `${g.type} `}${g.devices.join(" ")}`).join(" ")}`
        : "";

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            await runTaskAndWait(
                { kind: "zfs_pool_create", name, vdevs: groups.filter((g) => g.devices.length > 0).map((g) => ({ type: g.type, devices: g.devices })) },
                serverId,
                { autoOpenModal: true },
            );
            onCreated();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="Create pool" onClose={onClose} width={640}>
            {loadError && <ErrorBanner>{loadError}</ErrorBanner>}
            {error && <ErrorBanner>{error}</ErrorBanner>}
            <label className={shared["login-field"]}>
                <span>Pool name</span>
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="tank" />
            </label>

            {devices === null && !loadError ? (
                <EmptyState>Loading disks…</EmptyState>
            ) : devices ? (
                <>
                    {groups.map((g) => (
                        <VdevGroupEditor
                            key={g.id}
                            group={g}
                            devices={devices}
                            allSelected={allSelected}
                            onChange={(next) => setGroups(groups.map((x) => (x.id === g.id ? next : x)))}
                            onRemove={() => setGroups(groups.filter((x) => x.id !== g.id))}
                        />
                    ))}
                    <button
                        className={shared.btn}
                        onClick={() => { setGroups([...groups, { id: nextId, type: "mirror", devices: [] }]); setNextId(nextId + 1); }}
                    >
                        Add vdev group
                    </button>

                    {nonRedundant && (
                        <p className={cx(shared.dim)} style={{ color: "var(--warn)" }}>
                            A stripe vdev has no redundancy — any disk failure loses the whole pool.
                        </p>
                    )}
                    {command && (
                        <pre className={cx(shared.mono, shared["logs-pre"])} style={{ marginTop: 12 }}>{command}</pre>
                    )}
                </>
            ) : null}

            <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                <button
                    className={cx(shared.btn, shared["btn-primary"])}
                    type="button"
                    disabled={busy || !name || groups.length === 0 || invalid}
                    onClick={submit}
                >
                    {busy ? "Creating…" : "Create pool"}
                </button>
            </div>
        </Modal>
    );
}

export function AddVdevModal({ serverId, pool, onClose, onAdded }: {
    serverId: string;
    pool: string;
    onClose: () => void;
    onAdded: () => void;
}) {
    const { devices, error: loadError } = useBlockDevices(serverId);
    const [group, setGroup] = useState<VdevGroup>({ id: 0, type: "mirror", devices: [] });
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const spec = VDEV_TYPES.find((v) => v.id === group.type)!;
    const invalid = group.devices.length < spec.minDevices;

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            await runTaskAndWait({ kind: "zfs_vdev_add", pool, vdev: { type: group.type, devices: group.devices } }, serverId, { autoOpenModal: true });
            onAdded();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title={`Add vdev to "${pool}"`} onClose={onClose} width={560}>
            {loadError && <ErrorBanner>{loadError}</ErrorBanner>}
            {error && <ErrorBanner>{error}</ErrorBanner>}
            <p style={{ marginTop: 0 }} className={shared.dim}>
                Adding a vdev widens the pool permanently — it can't be removed again (only replaced disk-by-disk).
            </p>
            {devices === null && !loadError ? (
                <EmptyState>Loading disks…</EmptyState>
            ) : devices ? (
                <VdevGroupEditor
                    group={group}
                    devices={devices}
                    allSelected={new Set(group.devices)}
                    onChange={setGroup}
                    onRemove={() => setGroup({ ...group, devices: [] })}
                />
            ) : null}
            <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                <button className={cx(shared.btn, shared["btn-primary"])} type="button" disabled={busy || invalid} onClick={submit}>
                    {busy ? "Adding…" : "Add vdev"}
                </button>
            </div>
        </Modal>
    );
}

export function ReplaceDeviceModal({ serverId, pool, oldDevice, onClose, onReplaced }: {
    serverId: string;
    pool: string;
    oldDevice: string;
    onClose: () => void;
    onReplaced: () => void;
}) {
    const { devices, error: loadError } = useBlockDevices(serverId);
    const [newDevice, setNewDevice] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function submit() {
        if (!newDevice) {
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await runTaskAndWait({ kind: "zfs_device_replace", pool, oldDevice, newDevice }, serverId, { autoOpenModal: true });
            onReplaced();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title={`Replace device in "${pool}"`} onClose={onClose} width={560}>
            {loadError && <ErrorBanner>{loadError}</ErrorBanner>}
            {error && <ErrorBanner>{error}</ErrorBanner>}
            <p style={{ marginTop: 0 }}>
                Replacing <span className={shared.mono}>{oldDevice}</span> starts a resilver — the pool stays
                online but degraded until it finishes.
            </p>
            {devices === null && !loadError ? (
                <EmptyState>Loading disks…</EmptyState>
            ) : devices ? (
                <DeviceMultiSelect
                    devices={devices}
                    selected={new Set(newDevice ? [newDevice] : [])}
                    disabledElsewhere={new Set()}
                    onToggle={(byId) => setNewDevice(newDevice === byId ? null : byId)}
                />
            ) : null}
            <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                <button className={cx(shared.btn, shared["btn-primary"])} type="button" disabled={busy || !newDevice} onClick={submit}>
                    {busy ? "Replacing…" : "Replace"}
                </button>
            </div>
        </Modal>
    );
}
