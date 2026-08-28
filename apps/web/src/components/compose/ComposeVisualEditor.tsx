import { useCallback, useEffect, useMemo, useState } from "react";
import type { Document } from "yaml";
import type { DirEntry, HostDevice, HostDeviceKind, HostDevices, ImageDefaults } from "@central/shared";
import {
    type DeviceRow,
    type EnvRow,
    type PortRow,
    type VolumeRow,
    addSeqItem,
    addService as addServiceToDoc,
    getSeqItems,
    getServiceField,
    listServiceNames,
    looksLikeHostPath,
    parseCompose,
    parseDeviceEntry,
    parseEnvironment,
    parsePortEntry,
    parseVolumeEntry,
    removeSeqItem,
    serializeDeviceRow,
    serializeEnvironment,
    serializePortRow,
    serializeVolumeRow,
    setSeqItem,
    setServiceField,
    stringifyCompose,
} from "../../lib/composeDoc";
import { validateComposeObject } from "../../lib/composeValidate";
import { api } from "../../api";
import { runTaskAndWait } from "../../taskRun";
import { cx } from "../../utils";
import { DirectoryPicker, fileTypeClass } from "../DirectoryPicker";
import { EmptyState, ErrorBanner, Modal } from "../ui";
import shared from "../../styles/shared.module.css";

const SERVICE_NAME_RE = /^[a-zA-Z0-9._-]+$/;
const RESTART_OPTIONS = ["", "no", "always", "on-failure", "unless-stopped"];
const PORT_NAME_SUGGESTIONS = ["web", "web-frontend", "web-backend", "api", "admin", "metrics", "other"];
const EMPTY_IMAGE_DEFAULTS: ImageDefaults = { present: false, volumes: [], ports: [], env: [] };

/** What each field needs to render its suggestions control: either the image's
 *  own declarations, or — when the image isn't on the host — the pull that
 *  would produce them. `docker image inspect` can only answer for an image
 *  that's local, so an unpulled image and one that declares nothing look
 *  identical from here; `present` is what separates them. */
interface ImageSuggestions {
    /** The service's image reference; empty while the field is blank. */
    ref: string;
    present: boolean;
    pulling: boolean;
    pull: () => void;
}

/** The header control next to a field's title: the suggestion picker once the
 *  image is pulled, the pull itself while it isn't. Nothing at all with no
 *  image typed yet — there's nothing to suggest from or pull. */
function SuggestionsButton({ image, count, label, onOpen }: {
    image: ImageSuggestions;
    count: number;
    label: string;
    onOpen: () => void;
}) {
    if (!image.ref) {
        return null;
    }
    if (!image.present) {
        return (
            <button
                type="button"
                className={cx(shared.btn, shared["btn-sm"])}
                disabled={image.pulling}
                title={`${image.ref} isn't on this host yet. Suggestions come from the image's own VOLUME/EXPOSE/ENV declarations, which can only be read from a pulled image.`}
                onClick={image.pull}
            >
                {image.pulling ? "Pulling image…" : "Pull image to show suggestions"}
            </button>
        );
    }
    if (count === 0) {
        return null;
    }
    return (
        <button type="button" className={cx(shared.btn, shared["btn-sm"])} onClick={onOpen}>
            {label} ({count})
        </button>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className={shared["login-field"]}>
            <span>{label}</span>
            {children}
        </label>
    );
}

function Row({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
    return (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {children}
            <button type="button" className={cx(shared.btn, shared["btn-sm"])} onClick={onRemove}>Remove</button>
        </div>
    );
}

/** Visual editor over a `compose.yaml` string — parses into a CST-preserving `yaml`
 *  Document, mutates the one node a widget touches, re-stringifies. Comments and
 *  formatting elsewhere in the file survive edits made here, so this and the raw
 *  YAML tab are two views of the same content, safe to switch between freely.
 *  Curated field set (image/restart/environment/ports/volumes/depends_on) — see
 *  doc/idea_app_system.md and the compose-editor plan for what's deliberately
 *  deferred to the YAML tab. */
export function ComposeVisualEditor({ value, onChange, hostId, stackDir }: {
    value: string;
    onChange: (next: string) => void;
    hostId: string;
    /** Absolute path of the stack's directory on `hostId` — volume Browse
     *  defaults to this folder, the level the compose file sits at
     *  (doc/idea_app_system.md §3), rather than the filesystem root. */
    stackDir: string;
}) {
    const doc = useMemo(() => parseCompose(value), [value]);
    const services = listServiceNames(doc);
    const [selected, setSelected] = useState<string | null>(services[0] ?? null);
    const [newServiceName, setNewServiceName] = useState("");
    const [nameError, setNameError] = useState<string | null>(null);

    const activeService = selected && services.includes(selected) ? selected : services[0] ?? null;

    function commit(mutate: (doc: Document) => void) {
        mutate(doc);
        onChange(stringifyCompose(doc));
    }

    function addService() {
        const name = newServiceName.trim();
        if (!name) {
            return;
        }
        if (!SERVICE_NAME_RE.test(name)) {
            setNameError("Use letters, numbers, '.', '_', '-' only");
            return;
        }
        if (services.includes(name)) {
            setNameError("A service with that name already exists");
            return;
        }
        setNameError(null);
        commit((d) => addServiceToDoc(d, name));
        setSelected(name);
        setNewServiceName("");
    }

    const errors = useMemo(() => validateComposeObject(doc.toJSON()), [doc]);
    const serviceErrors = activeService
        ? errors.filter((e) => e.path.startsWith(`/services/${activeService}`))
        : [];

    return (
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
            <div style={{ width: 180, borderRight: "1px solid var(--border)", padding: 10, display: "flex", flexDirection: "column", gap: 4, overflowY: "auto" }}>
                {services.map((s) => (
                    <button
                        key={s}
                        type="button"
                        className={cx(shared["sub-tab"], activeService === s && shared.active)}
                        style={{ textAlign: "left", width: "100%" }}
                        onClick={() => setSelected(s)}
                    >
                        {s}
                    </button>
                ))}
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                    <input
                        value={newServiceName}
                        onChange={(e) => { setNewServiceName(e.target.value); setNameError(null); }}
                        placeholder="new service name"
                        style={{ fontSize: 12 }}
                    />
                    <button type="button" className={cx(shared.btn, shared["btn-sm"])} onClick={addService}>+ Add service</button>
                    {nameError && <span className={shared.dim} style={{ color: "var(--err)", fontSize: 11 }}>{nameError}</span>}
                </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 16 }}>
                {!activeService ? (
                    <EmptyState>No services yet — add one on the left.</EmptyState>
                ) : (
                    <ServiceEditor
                        key={activeService}
                        doc={doc}
                        service={activeService}
                        hostId={hostId}
                        stackDir={stackDir}
                        otherServices={services.filter((s) => s !== activeService)}
                        errors={serviceErrors}
                        commit={commit}
                    />
                )}
            </div>
        </div>
    );
}

function ServiceEditor({ doc, service, hostId, stackDir, otherServices, errors, commit }: {
    doc: Document;
    service: string;
    hostId: string;
    stackDir: string;
    otherServices: string[];
    errors: { path: string; message: string }[];
    commit: (mutate: (doc: Document) => void) => void;
}) {
    const image = getServiceField<string>(doc, service, "image") ?? "";
    const restart = getServiceField<string>(doc, service, "restart") ?? "";

    // What the image's Dockerfile already declares (VOLUME/EXPOSE/ENV) — one
    // inspect per image, shared by the three fields below rather than each
    // fetching it separately.
    const [defaults, setDefaults] = useState<ImageDefaults>(EMPTY_IMAGE_DEFAULTS);
    const [pulling, setPulling] = useState(false);
    // Bumped after a pull so the inspect re-runs for the same image reference.
    const [pullCount, setPullCount] = useState(0);
    useEffect(() => {
        if (!image) {
            setDefaults(EMPTY_IMAGE_DEFAULTS);
            return;
        }
        let alive = true;
        api("dockerImageDefaults", { serverId: hostId, image })
            .then((r) => { if (alive) setDefaults(r); })
            .catch(() => { if (alive) setDefaults(EMPTY_IMAGE_DEFAULTS); });
        return () => { alive = false; };
    }, [hostId, image, pullCount]);

    // Pulling here is a read, not a deploy: nothing in the stack is started or
    // recreated, the image just becomes inspectable so the suggestion pickers
    // have something to offer.
    async function pullImage() {
        if (!image || pulling) {
            return;
        }
        setPulling(true);
        try {
            await runTaskAndWait({ kind: "docker_image_pull", ref: image }, hostId, { feedback: "modal" });
        } catch { /* the task modal carries the failure; the button just goes idle */ }
        setPulling(false);
        setPullCount((n) => n + 1);
    }

    const suggestions: ImageSuggestions = { ref: image, present: defaults.present, pulling, pull: () => void pullImage() };

    return (
        <>
            {errors.length > 0 && (
                <div style={{ background: "color-mix(in srgb, var(--err) 12%, transparent)", border: "1px solid color-mix(in srgb, var(--err) 40%, var(--border))", borderRadius: 6, padding: "8px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
                    {errors.map((e, i) => (
                        <span key={i} className={shared.mono} style={{ fontSize: 12, color: "var(--err)" }}>{e.path}: {e.message}</span>
                    ))}
                </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 200px", gap: 12 }}>
                <Field label="Image">
                    <input
                        className={shared.mono}
                        value={image}
                        onChange={(e) => commit((d) => setServiceField(d, service, "image", e.target.value))}
                        placeholder="jellyfin/jellyfin:latest"
                        spellCheck={false}
                    />
                </Field>
                <Field label="Restart policy">
                    <select
                        value={restart}
                        onChange={(e) => commit((d) => setServiceField(d, service, "restart", e.target.value))}
                    >
                        {RESTART_OPTIONS.map((o) => <option key={o} value={o}>{o || "(unset)"}</option>)}
                    </select>
                </Field>
            </div>

            <PortsField doc={doc} service={service} commit={commit} suggestedPorts={defaults.ports} image={suggestions} />
            <VolumesField doc={doc} service={service} hostId={hostId} stackDir={stackDir} commit={commit} suggestedTargets={defaults.volumes} image={suggestions} />
            <DevicesField doc={doc} service={service} hostId={hostId} commit={commit} />
            <EnvironmentField doc={doc} service={service} commit={commit} suggestedEnv={defaults.env} image={suggestions} />
            <DependsOnField doc={doc} service={service} otherServices={otherServices} commit={commit} />
        </>
    );
}

// ---- ports --------------------------------------------------------------------------

const EMPTY_PORT_ROW: PortRow = { kind: "short", published: "", target: "", protocol: "tcp", name: "" };

function PortsField({ doc, service, commit, suggestedPorts, image }: {
    doc: Document; service: string; commit: (mutate: (doc: Document) => void) => void;
    suggestedPorts: { port: number; protocol: "tcp" | "udp" }[];
    image: ImageSuggestions;
}) {
    const path = ["services", service, "ports"];
    const rows = getSeqItems<unknown>(doc, path).map(parsePortEntry);
    // A row being filled in that isn't valid compose syntax yet (e.g. no
    // container port typed) — kept out of the document until it graduates,
    // otherwise "+ Add port" would write an empty/unparseable entry straight
    // into the file and it'd either vanish or show as unrecognized.
    const [pending, setPending] = useState<PortRow | null>(null);
    const [showSuggested, setShowSuggested] = useState(false);

    function update(i: number, patch: Partial<PortRow>) {
        commit((d) => setSeqItem(d, path, i, serializePortRow({ ...rows[i], ...patch })));
    }

    function createSuggested(port: number, protocol: "tcp" | "udp") {
        commit((d) => addSeqItem(d, path, serializePortRow({
            kind: "short", published: String(port), target: String(port), protocol, name: "",
        })));
    }

    function updatePending(patch: Partial<PortRow>) {
        const next = { ...(pending ?? EMPTY_PORT_ROW), ...patch };
        if (next.target.trim()) {
            commit((d) => addSeqItem(d, path, serializePortRow(next)));
            setPending(null);
        } else {
            setPending(next);
        }
    }

    function portRowCells(row: PortRow, onEdit: (patch: Partial<PortRow>) => void, onRemove: () => void) {
        return (
            <>
                <td>
                    <input
                        className={shared.mono}
                        style={{ width: "100%" }}
                        placeholder="(auto)"
                        value={row.published}
                        onChange={(e) => onEdit({ published: e.target.value })}
                    />
                </td>
                <td className={shared.dim} style={{ textAlign: "center" }}>→</td>
                <td>
                    <input
                        className={shared.mono}
                        style={{ width: "100%" }}
                        placeholder="80"
                        value={row.target}
                        onChange={(e) => onEdit({ target: e.target.value })}
                    />
                </td>
                <td>
                    <select style={{ width: "100%" }} value={row.protocol} onChange={(e) => onEdit({ protocol: e.target.value as "tcp" | "udp" })}>
                        <option value="tcp">tcp</option>
                        <option value="udp">udp</option>
                    </select>
                </td>
                <td>
                    <input
                        style={{ width: "100%" }}
                        list="sc-port-name-suggestions"
                        placeholder="web, admin, …"
                        value={row.name}
                        onChange={(e) => onEdit({ name: e.target.value })}
                    />
                </td>
                <td>
                    <button type="button" className={cx(shared.btn, shared["btn-sm"])} onClick={onRemove}>Remove</button>
                </td>
            </>
        );
    }

    return (
        <section>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <h3 style={{ fontSize: 13, margin: 0 }}>Ports</h3>
                <SuggestionsButton image={image} count={suggestedPorts.length} label="Suggested ports" onOpen={() => setShowSuggested(true)} />
            </div>
            <datalist id="sc-port-name-suggestions">
                {PORT_NAME_SUGGESTIONS.map((s) => <option key={s} value={s} />)}
            </datalist>
            {showSuggested && (
                <Modal title="Suggested ports" onClose={() => setShowSuggested(false)} width={420}>
                    <p className={shared.dim} style={{ fontSize: 12, marginTop: 0 }}>
                        Exposed by this image's Dockerfile. "Create" publishes it at the same host port — adjust afterward if needed.
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {suggestedPorts.map(({ port, protocol }) => {
                            const mapped = rows.some((r) => r.kind !== "raw" && r.target === String(port) && r.protocol === protocol);
                            return (
                                <div key={`${port}/${protocol}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <span className={shared.mono} style={{ flex: 1, fontSize: 12 }}>{port}/{protocol}</span>
                                    {mapped ? (
                                        <span className={cx(shared.badge, shared["badge-ok"])}>mapped</span>
                                    ) : (
                                        <button type="button" className={cx(shared.btn, shared["btn-sm"])} onClick={() => createSuggested(port, protocol)}>
                                            + Create
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <div className={shared["modal-actions"]} style={{ marginTop: 12 }}>
                        <button type="button" className={shared.btn} onClick={() => setShowSuggested(false)}>Close</button>
                    </div>
                </Modal>
            )}
            {rows.length === 0 && !pending ? (
                <EmptyState>No ports published.</EmptyState>
            ) : (
                <table className={shared["data-table"]}>
                    <colgroup>
                        <col style={{ width: 90 }} />
                        <col style={{ width: 20 }} />
                        <col style={{ width: 90 }} />
                        <col style={{ width: 80 }} />
                        <col />
                        <col style={{ width: 1 }} />
                    </colgroup>
                    <thead>
                        <tr>
                            <th>Host port</th>
                            <th />
                            <th>Container port</th>
                            <th>Protocol</th>
                            <th>Name</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row, i) => (
                            <tr key={i}>
                                {row.kind === "raw" ? (
                                    <>
                                        <td colSpan={5} className={cx(shared.mono, shared.dim)} style={{ fontSize: 12 }}>
                                            {typeof row.raw === "string" ? row.raw : JSON.stringify(row.raw)} — advanced syntax, edit in YAML tab
                                        </td>
                                        <td><button type="button" className={cx(shared.btn, shared["btn-sm"])} onClick={() => commit((d) => removeSeqItem(d, path, i))}>Remove</button></td>
                                    </>
                                ) : (
                                    portRowCells(row, (patch) => update(i, patch), () => commit((d) => removeSeqItem(d, path, i)))
                                )}
                            </tr>
                        ))}
                        {pending && <tr>{portRowCells(pending, updatePending, () => setPending(null))}</tr>}
                    </tbody>
                </table>
            )}
            <button
                type="button"
                className={cx(shared.btn, shared["btn-sm"])}
                style={{ marginTop: 8 }}
                onClick={() => setPending(EMPTY_PORT_ROW)}
                disabled={pending !== null}
            >
                + Add port
            </button>
        </section>
    );
}

// ---- volumes ------------------------------------------------------------------------

const EMPTY_VOLUME_ROW: VolumeRow = { kind: "short", source: "", target: "", readOnly: false };

/**
 * Two tabs: "Simple" — a flat list of what's already directly in the stack's own
 * folder, next to its compose file, plus a one-click "new folder" — and
 * "Custom", the full host tree (files included, for bind-mounting a single
 * existing file, or reaching somewhere else on the host entirely) for the
 * escape-hatch case. Defaults to Simple: most mounts are either something
 * already there or a fresh folder beside the compose file.
 */
function VolumeSourcePicker({ serverId, stackDir, value, onChange }: {
    serverId: string;
    stackDir: string;
    value: string;
    onChange: (path: string) => void;
}) {
    const stackFolder = stackDir.replace(/\/$/, "");
    const [mode, setMode] = useState<"simple" | "custom">("simple");
    const [entries, setEntries] = useState<DirEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
        setEntries(null);
        api("listDir", { serverId, path: stackFolder })
            .then((d) => setEntries(d.entries))
            .catch(() => setEntries([]));
    }, [serverId, stackFolder]);

    useEffect(() => {
        if (mode === "simple") {
            load();
        }
    }, [mode, load]);

    async function createFolder() {
        const name = prompt("New folder name:");
        if (!name) {
            return;
        }
        const created = `${stackFolder}/${name}`;
        try {
            await api("createDir", { serverId, path: created });
            onChange(created);
            load();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    return (
        <div>
            <nav className={shared["sub-tabs"]} style={{ marginBottom: 10 }}>
                <button className={cx(shared["sub-tab"], mode === "simple" && shared.active)} onClick={() => setMode("simple")}>Simple</button>
                <button className={cx(shared["sub-tab"], mode === "custom" && shared.active)} onClick={() => setMode("custom")}>Custom</button>
            </nav>

            {mode === "custom" ? (
                <DirectoryPicker serverId={serverId} value={looksLikeHostPath(value) ? value : stackFolder} onChange={onChange} selectFiles />
            ) : (
                <>
                    <div className={cx(shared.mono, shared.dim)} style={{ fontSize: 12, marginBottom: 6 }}>{stackFolder}</div>
                    {error && <ErrorBanner>{error}</ErrorBanner>}
                    <div style={{ maxHeight: 200, overflow: "auto", border: "1px solid var(--border)", borderRadius: 4 }}>
                        {entries === null ? (
                            <div className={shared.dim} style={{ padding: 8, fontSize: 12 }}>Loading…</div>
                        ) : entries.length === 0 ? (
                            <div className={shared.dim} style={{ padding: 8, fontSize: 12 }}>Nothing here yet — create one below.</div>
                        ) : (
                            entries.map((e) => {
                                const entryPath = `${stackFolder}/${e.name}`;
                                return (
                                    <div
                                        key={e.name}
                                        className={cx(shared["file-name"], fileTypeClass[e.type], shared["row-clickable"])}
                                        style={{ padding: "5px 8px", background: value === entryPath ? "var(--accent-soft)" : undefined }}
                                        onClick={() => onChange(entryPath)}
                                    >
                                        {e.name}{e.type === "symlink" && " →"}
                                    </div>
                                );
                            })
                        )}
                    </div>
                    <button type="button" className={cx(shared.btn, shared["btn-sm"])} style={{ marginTop: 8 }} onClick={() => void createFolder()}>
                        + New folder
                    </button>
                </>
            )}
        </div>
    );
}

function VolumesField({ doc, service, hostId, stackDir, commit, suggestedTargets, image }: {
    doc: Document; service: string; hostId: string; stackDir: string; commit: (mutate: (doc: Document) => void) => void;
    suggestedTargets: string[];
    image: ImageSuggestions;
}) {
    const path = ["services", service, "volumes"];
    const rows = getSeqItems<unknown>(doc, path).map(parseVolumeEntry);
    const [browsing, setBrowsing] = useState<"pending" | number | null>(null);
    // Same reasoning as PortsField's `pending` — don't write a blank/half-typed
    // mount into the document.
    const [pending, setPending] = useState<VolumeRow | null>(null);
    const [showSuggested, setShowSuggested] = useState(false);

    async function createSuggested(containerPath: string) {
        const folderName = containerPath.split("/").filter(Boolean).pop() || "data";
        const hostDir = `${stackDir.replace(/\/$/, "")}/${folderName}`;
        await api("createDir", { serverId: hostId, path: hostDir });
        commit((d) => addSeqItem(d, path, serializeVolumeRow({ kind: "short", source: hostDir, target: containerPath, readOnly: false })));
    }

    function update(i: number, patch: Partial<VolumeRow>) {
        commit((d) => setSeqItem(d, path, i, serializeVolumeRow({ ...rows[i], ...patch })));
    }

    function updatePending(patch: Partial<VolumeRow>) {
        const next = { ...(pending ?? EMPTY_VOLUME_ROW), ...patch };
        if (next.source.trim() && next.target.trim()) {
            commit((d) => addSeqItem(d, path, serializeVolumeRow(next)));
            setPending(null);
        } else {
            setPending(next);
        }
    }

    function volumeRowFields(row: VolumeRow, onEdit: (patch: Partial<VolumeRow>) => void, onRemove: () => void, browseKey: "pending" | number) {
        return (
            <Row onRemove={onRemove}>
                <button
                    type="button"
                    className={cx(shared["picker-field"], shared.mono)}
                    style={{ flex: 1 }}
                    onClick={() => setBrowsing(browseKey)}
                >
                    <span className={shared["picker-field-value"]}>
                        {row.source || <span className={shared.dim}>Click to choose a source…</span>}
                    </span>
                    <span className={shared["picker-field-affordance"]}>{row.source ? "Change" : "Choose"}</span>
                </button>
                <span className={shared.dim}>→</span>
                <input
                    style={{ flex: 1 }}
                    className={shared.mono}
                    list="sc-volume-target-suggestions"
                    placeholder="/container/path"
                    value={row.target}
                    onChange={(e) => onEdit({ target: e.target.value })}
                />
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                    <input type="checkbox" checked={row.readOnly} onChange={(e) => onEdit({ readOnly: e.target.checked })} />
                    ro
                </label>
                {browsing === browseKey && (
                    <Modal title="Choose a volume source" onClose={() => setBrowsing(null)} width={560}>
                        <VolumeSourcePicker
                            serverId={hostId}
                            stackDir={stackDir}
                            value={row.source}
                            onChange={(v) => onEdit({ source: v })}
                        />
                        <div className={shared["modal-actions"]} style={{ marginTop: 12 }}>
                            <button type="button" className={cx(shared.btn, shared["btn-primary"])} onClick={() => setBrowsing(null)}>Done</button>
                        </div>
                    </Modal>
                )}
            </Row>
        );
    }

    return (
        <section>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <h3 style={{ fontSize: 13, margin: 0 }}>Volumes</h3>
                <SuggestionsButton image={image} count={suggestedTargets.length} label="Suggested volumes" onOpen={() => setShowSuggested(true)} />
            </div>
            <datalist id="sc-volume-target-suggestions">
                {suggestedTargets.map((p) => <option key={p} value={p} />)}
            </datalist>
            {showSuggested && (
                <Modal title="Suggested volumes" onClose={() => setShowSuggested(false)} width={520}>
                    <p className={shared.dim} style={{ fontSize: 12, marginTop: 0 }}>
                        Declared by this service's image. "Create" adds a matching folder next to
                        the compose file and maps it here.
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {suggestedTargets.map((p) => {
                            const mapped = rows.some((r) => r.kind !== "raw" && r.target === p);
                            return (
                                <div key={p} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <span className={shared.mono} style={{ flex: 1, fontSize: 12 }}>{p}</span>
                                    {mapped ? (
                                        <span className={cx(shared.badge, shared["badge-ok"])}>mapped</span>
                                    ) : (
                                        <button type="button" className={cx(shared.btn, shared["btn-sm"])} onClick={() => void createSuggested(p)}>
                                            + Create
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <div className={shared["modal-actions"]} style={{ marginTop: 12 }}>
                        <button type="button" className={shared.btn} onClick={() => setShowSuggested(false)}>Close</button>
                    </div>
                </Modal>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {rows.map((row, i) => row.kind === "raw" ? (
                    <Row key={i} onRemove={() => commit((d) => removeSeqItem(d, path, i))}>
                        <span className={cx(shared.mono, shared.dim)} style={{ fontSize: 12, flex: 1 }}>
                            {typeof row.raw === "string" ? row.raw : JSON.stringify(row.raw)} — advanced syntax, edit in YAML tab
                        </span>
                    </Row>
                ) : (
                    <div key={i}>{volumeRowFields(row, (patch) => update(i, patch), () => commit((d) => removeSeqItem(d, path, i)), i)}</div>
                ))}
                {pending && volumeRowFields(pending, updatePending, () => { setPending(null); setBrowsing(null); }, "pending")}
                <button
                    type="button"
                    className={cx(shared.btn, shared["btn-sm"])}
                    style={{ alignSelf: "flex-start" }}
                    onClick={() => setPending(EMPTY_VOLUME_ROW)}
                    disabled={pending !== null}
                >
                    + Add volume
                </button>
            </div>
        </section>
    );
}

// ---- devices ------------------------------------------------------------------------

const EMPTY_DEVICE_ROW: DeviceRow = { kind: "short", source: "", target: "", permissions: "" };

const DEVICE_KIND_LABEL: Record<HostDeviceKind, string> = {
    serial: "Serial adapters",
    gpu: "GPU",
    video: "Video capture",
    tun: "Network tunnel",
    other: "Other",
};

const DEVICE_KIND_ORDER: HostDeviceKind[] = ["serial", "gpu", "video", "tun", "other"];

/** Maps host device nodes into the container (compose `devices:`) — the field a
 *  Zigbee/Z-Wave stick or a GPU passthrough needs. The picker is fed by the
 *  host's own `/dev` scan rather than free text, because the path that belongs in
 *  a compose file (`/dev/serial/by-id/usb-…`) is exactly the one nobody can type
 *  from memory, and the one that's obvious (`/dev/ttyACM0`) is the one that
 *  silently moves between reboots. */
function DevicesField({ doc, service, hostId, commit }: {
    doc: Document; service: string; hostId: string; commit: (mutate: (doc: Document) => void) => void;
}) {
    const path = ["services", service, "devices"];
    const rows = getSeqItems<unknown>(doc, path).map(parseDeviceEntry);
    // Same reasoning as PortsField's `pending`: a row with no host path yet isn't
    // a device mapping, and writing it would produce a bare `- ` compose rejects.
    const [pending, setPending] = useState<DeviceRow | null>(null);
    const [picking, setPicking] = useState<"pending" | "browse" | number | null>(null);
    const [hostDevices, setHostDevices] = useState<HostDevices | null>(null);

    useEffect(() => {
        let alive = true;
        api("listHostDevices", { serverId: hostId })
            .then((r) => { if (alive) setHostDevices(r); })
            .catch((err) => { if (alive) setHostDevices({ devices: [], error: err instanceof Error ? err.message : String(err) }); });
        return () => { alive = false; };
    }, [hostId]);

    const available = hostDevices?.devices ?? [];
    // A device counts as mapped under any of its names — picking the by-id path
    // and then the raw node it resolves to would map the same hardware twice.
    const mappedPaths = new Set(rows.filter((r) => r.kind !== "raw").map((r) => r.source));
    function isMapped(dev: HostDevice): boolean {
        return mappedPaths.has(dev.path) || mappedPaths.has(dev.node) || dev.aliases.some((a) => mappedPaths.has(a));
    }

    function update(i: number, patch: Partial<DeviceRow>) {
        commit((d) => setSeqItem(d, path, i, serializeDeviceRow({ ...rows[i], ...patch })));
    }

    function updatePending(patch: Partial<DeviceRow>) {
        const next = { ...(pending ?? EMPTY_DEVICE_ROW), ...patch };
        if (next.source.trim()) {
            commit((d) => addSeqItem(d, path, serializeDeviceRow(next)));
            setPending(null);
        } else {
            setPending(next);
        }
    }

    function addDevice(dev: HostDevice) {
        commit((d) => addSeqItem(d, path, serializeDeviceRow({ ...EMPTY_DEVICE_ROW, source: dev.path })));
        setPicking(null);
    }

    function deviceRowFields(row: DeviceRow, onEdit: (patch: Partial<DeviceRow>) => void, onRemove: () => void, pickKey: "pending" | number) {
        return (
            <Row onRemove={onRemove}>
                <input
                    style={{ flex: 1 }}
                    className={shared.mono}
                    list="sc-host-device-paths"
                    placeholder="/dev/serial/by-id/…"
                    value={row.source}
                    onChange={(e) => onEdit({ source: e.target.value })}
                />
                <button type="button" className={cx(shared.btn, shared["btn-sm"])} onClick={() => setPicking(pickKey)}>
                    Pick…
                </button>
                <span className={shared.dim}>→</span>
                <input
                    style={{ flex: 1 }}
                    className={shared.mono}
                    placeholder={row.source || "same path in container"}
                    value={row.target}
                    onChange={(e) => onEdit({ target: e.target.value })}
                />
                <input
                    style={{ width: 64 }}
                    className={shared.mono}
                    placeholder="rwm"
                    title="Cgroup permissions: read, write, mknod. Blank means compose's default, rwm."
                    value={row.permissions}
                    onChange={(e) => onEdit({ permissions: e.target.value })}
                />
                {picking === pickKey && (
                    <Modal title="Host devices" onClose={() => setPicking(null)} width={620}>
                        <DevicePicker
                            state={hostDevices}
                            isMapped={isMapped}
                            onPick={(dev) => { onEdit({ source: dev.path }); setPicking(null); }}
                        />
                        <div className={shared["modal-actions"]} style={{ marginTop: 12 }}>
                            <button type="button" className={shared.btn} onClick={() => setPicking(null)}>Cancel</button>
                        </div>
                    </Modal>
                )}
            </Row>
        );
    }

    return (
        <section>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <h3 style={{ fontSize: 13, margin: 0 }}>Devices</h3>
                {available.length > 0 && (
                    <button type="button" className={cx(shared.btn, shared["btn-sm"])} onClick={() => setPicking("browse")}>
                        Host devices ({available.length})
                    </button>
                )}
            </div>
            <datalist id="sc-host-device-paths">
                {available.map((d) => <option key={d.path} value={d.path} />)}
            </datalist>
            {picking === "browse" && (
                <Modal title="Host devices" onClose={() => setPicking(null)} width={620}>
                    <DevicePicker state={hostDevices} isMapped={isMapped} onPick={addDevice} addLabel />
                    <div className={shared["modal-actions"]} style={{ marginTop: 12 }}>
                        <button type="button" className={shared.btn} onClick={() => setPicking(null)}>Close</button>
                    </div>
                </Modal>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {rows.map((row, i) => row.kind === "raw" ? (
                    <Row key={i} onRemove={() => commit((d) => removeSeqItem(d, path, i))}>
                        <span className={cx(shared.mono, shared.dim)} style={{ fontSize: 12, flex: 1 }}>
                            {typeof row.raw === "string" ? row.raw : JSON.stringify(row.raw)} — advanced syntax, edit in YAML tab
                        </span>
                    </Row>
                ) : (
                    <div key={i}>{deviceRowFields(row, (patch) => update(i, patch), () => commit((d) => removeSeqItem(d, path, i)), i)}</div>
                ))}
                {pending && deviceRowFields(pending, updatePending, () => { setPending(null); setPicking(null); }, "pending")}
                <button
                    type="button"
                    className={cx(shared.btn, shared["btn-sm"])}
                    style={{ alignSelf: "flex-start" }}
                    onClick={() => setPending(EMPTY_DEVICE_ROW)}
                    disabled={pending !== null}
                >
                    + Add device
                </button>
            </div>
        </section>
    );
}

/** The host's scanned `/dev` shortlist, grouped by kind. `null` state is the scan
 *  still running — distinct from a completed scan that found nothing, which is a
 *  real answer about the host and says so. */
function DevicePicker({ state, isMapped, onPick, addLabel }: {
    state: HostDevices | null;
    isMapped: (dev: HostDevice) => boolean;
    onPick: (dev: HostDevice) => void;
    /** Label the action "+ Add" (adds a row) rather than "Use" (fills the row
     *  the picker was opened from). */
    addLabel?: boolean;
}) {
    if (!state) {
        return <EmptyState>Scanning /dev…</EmptyState>;
    }
    if (state.error) {
        return <ErrorBanner>{state.error}</ErrorBanner>;
    }
    if (state.devices.length === 0) {
        return <EmptyState>No serial, GPU, video or tunnel devices found on this host.</EmptyState>;
    }
    return (
        <>
            <p className={shared.dim} style={{ fontSize: 12, marginTop: 0 }}>
                Prefer a <span className={shared.mono}>/dev/serial/by-id/…</span> path where one exists — it
                survives reboots and re-plugs, unlike the <span className={shared.mono}>/dev/ttyACM0</span> it
                points at. Set a container path on the row if the app expects a fixed name.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 380, overflowY: "auto" }}>
                {DEVICE_KIND_ORDER.map((kind) => {
                    const group = state.devices.filter((d) => d.kind === kind);
                    if (group.length === 0) {
                        return null;
                    }
                    return (
                        <div key={kind} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)" }}>
                                {DEVICE_KIND_LABEL[kind]}
                            </span>
                            {group.map((dev) => (
                                <div key={dev.path} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                                        {dev.label && <span style={{ fontSize: 12.5, fontWeight: 600 }}>{dev.label}</span>}
                                        <span className={shared.mono} style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            {dev.path}
                                        </span>
                                        {dev.node !== dev.path && (
                                            <span className={cx(shared.dim, shared.mono)} style={{ fontSize: 11 }}>→ {dev.node}</span>
                                        )}
                                    </div>
                                    {isMapped(dev) ? (
                                        <span className={cx(shared.badge, shared["badge-ok"])}>mapped</span>
                                    ) : (
                                        <button type="button" className={cx(shared.btn, shared["btn-sm"])} onClick={() => onPick(dev)}>
                                            {addLabel ? "+ Add" : "Use"}
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    );
                })}
            </div>
        </>
    );
}

// ---- environment --------------------------------------------------------------------

function EnvironmentField({ doc, service, commit, suggestedEnv, image }: {
    doc: Document; service: string; commit: (mutate: (doc: Document) => void) => void;
    suggestedEnv: { key: string; value: string }[];
    image: ImageSuggestions;
}) {
    const raw = getServiceField<unknown>(doc, service, "environment");
    const { rows, asObject } = parseEnvironment(raw);
    // Same reasoning as PortsField's `pending` — a blank key would just be
    // filtered back out by serializeEnvironment, so "+ Add variable" would
    // look like it did nothing.
    const [pending, setPending] = useState<EnvRow | null>(null);
    const [showSuggested, setShowSuggested] = useState(false);

    function writeRows(next: EnvRow[]) {
        commit((d) => setServiceField(d, service, "environment", serializeEnvironment(next, asObject)));
    }

    function updatePending(patch: Partial<EnvRow>) {
        const next = { ...(pending ?? { key: "", value: "" }), ...patch };
        if (next.key.trim()) {
            writeRows([...rows, next]);
            setPending(null);
        } else {
            setPending(next);
        }
    }

    return (
        <section>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <h3 style={{ fontSize: 13, margin: 0 }}>Environment</h3>
                <SuggestionsButton image={image} count={suggestedEnv.length} label="Suggested variables" onOpen={() => setShowSuggested(true)} />
            </div>
            {showSuggested && (
                <Modal title="Suggested environment variables" onClose={() => setShowSuggested(false)} width={560}>
                    <p className={shared.dim} style={{ fontSize: 12, marginTop: 0 }}>
                        Defaults already baked into this image — everything it sets via <span className={shared.mono}>ENV</span>,
                        not just app-specific config. "Create" adds it here, explicit and overridable.
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
                        {suggestedEnv.map((s) => {
                            const mapped = rows.some((r) => r.key === s.key);
                            return (
                                <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <span className={shared.mono} style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                        {s.key}={s.value}
                                    </span>
                                    {mapped ? (
                                        <span className={cx(shared.badge, shared["badge-ok"])}>mapped</span>
                                    ) : (
                                        <button type="button" className={cx(shared.btn, shared["btn-sm"])} onClick={() => writeRows([...rows, s])}>
                                            + Create
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <div className={shared["modal-actions"]} style={{ marginTop: 12 }}>
                        <button type="button" className={shared.btn} onClick={() => setShowSuggested(false)}>Close</button>
                    </div>
                </Modal>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {rows.map((row, i) => (
                    <Row key={i} onRemove={() => writeRows(rows.filter((_, j) => j !== i))}>
                        <input
                            style={{ width: 200 }}
                            className={shared.mono}
                            placeholder="KEY"
                            value={row.key}
                            onChange={(e) => writeRows(rows.map((r, j) => j === i ? { ...r, key: e.target.value } : r))}
                        />
                        <span className={shared.dim}>=</span>
                        <input
                            style={{ flex: 1 }}
                            className={shared.mono}
                            placeholder="value"
                            value={row.value}
                            onChange={(e) => writeRows(rows.map((r, j) => j === i ? { ...r, value: e.target.value } : r))}
                        />
                    </Row>
                ))}
                {pending && (
                    <Row onRemove={() => setPending(null)}>
                        <input
                            style={{ width: 200 }}
                            className={shared.mono}
                            placeholder="KEY"
                            autoFocus
                            value={pending.key}
                            onChange={(e) => updatePending({ key: e.target.value })}
                        />
                        <span className={shared.dim}>=</span>
                        <input
                            style={{ flex: 1 }}
                            className={shared.mono}
                            placeholder="value"
                            value={pending.value}
                            onChange={(e) => updatePending({ value: e.target.value })}
                        />
                    </Row>
                )}
                <button
                    type="button"
                    className={cx(shared.btn, shared["btn-sm"])}
                    style={{ alignSelf: "flex-start" }}
                    onClick={() => setPending({ key: "", value: "" })}
                    disabled={pending !== null}
                >
                    + Add variable
                </button>
            </div>
        </section>
    );
}

// ---- depends_on -----------------------------------------------------------------

function DependsOnField({ doc, service, otherServices, commit }: {
    doc: Document; service: string; otherServices: string[]; commit: (mutate: (doc: Document) => void) => void;
}) {
    const raw = getServiceField<unknown>(doc, service, "depends_on");
    if (raw !== undefined && !Array.isArray(raw)) {
        return (
            <section>
                <h3 style={{ fontSize: 13, marginBottom: 6 }}>Depends on</h3>
                <span className={cx(shared.mono, shared.dim)} style={{ fontSize: 12 }}>Advanced form in use — edit in YAML tab.</span>
            </section>
        );
    }
    const selected = new Set((raw as string[] | undefined) ?? []);

    function toggle(name: string) {
        const next = new Set(selected);
        if (next.has(name)) {
            next.delete(name);
        } else {
            next.add(name);
        }
        commit((d) => setServiceField(d, service, "depends_on", next.size > 0 ? [...next] : undefined));
    }

    if (otherServices.length === 0) {
        return null;
    }

    return (
        <section>
            <h3 style={{ fontSize: 13, marginBottom: 6 }}>Depends on</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {otherServices.map((s) => (
                    <label key={s} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                        <input type="checkbox" checked={selected.has(s)} onChange={() => toggle(s)} />
                        {s}
                    </label>
                ))}
            </div>
        </section>
    );
}
