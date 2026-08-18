import { useState } from "react";
import type { AppDetection, ServerEntry } from "@central/shared";
import { api } from "../api";
import { cx } from "../utils";
import { DirectoryPicker } from "./DirectoryPicker";
import { ErrorBanner, Modal } from "./ui";
import shared from "../styles/shared.module.css";

type Step = "location" | "detected" | "confirm";
const STEPS: { id: Step; label: string }[] = [
    { id: "location", label: "Location" },
    { id: "detected", label: "Detected" },
    { id: "confirm", label: "Confirm" },
];

function StepStrip({ current }: { current: Step }) {
    const idx = STEPS.findIndex((s) => s.id === current);
    return (
        <div style={{ display: "flex", gap: 8, padding: "12px 16px", borderBottom: "1px solid var(--border)", background: "var(--panel-2)", alignItems: "center" }}>
            {STEPS.map((s, i) => {
                const done = i < idx;
                const active = i === idx;
                return (
                    <span key={s.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        {i > 0 && <span style={{ color: "var(--border)" }}>—</span>}
                        <span style={{ display: "flex", alignItems: "center", gap: 7, color: active ? "var(--accent)" : "var(--muted)", fontWeight: active ? 600 : 400 }}>
                            <span style={{
                                width: 18, height: 18, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center",
                                fontSize: 11, fontWeight: 700,
                                background: done ? "color-mix(in srgb, var(--ok) 14%, transparent)" : active ? "var(--accent)" : "var(--bg)",
                                color: done ? "var(--ok)" : active ? "#fff" : "var(--muted)",
                            }}>
                                {done ? "✓" : i + 1}
                            </span>
                            {s.label}
                        </span>
                    </span>
                );
            })}
        </div>
    );
}

/** Design ref 1l: stepped modal — the detection result (step 2) is the thing
 *  worth a step of its own. */
export function ImportAppModal({ servers, onClose, onImported }: {
    servers: ServerEntry[];
    onClose: () => void;
    onImported: (appId: string) => void;
}) {
    const [step, setStep] = useState<Step>("location");
    const [hostId, setHostId] = useState(servers[0]?.id ?? "");
    const [dir, setDir] = useState("/opt/sc-apps");
    const [detection, setDetection] = useState<AppDetection | null>(null);
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function detect() {
        setError(null);
        setBusy(true);
        try {
            const result = await api("detectApp", { hostId, dir });
            setDetection(result);
            setName(result.predictedName);
            setStep("detected");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function doImport() {
        setError(null);
        setBusy(true);
        try {
            const app = await api("importApp", { hostId, dir, name });
            onImported(app.id);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="Import existing App" onClose={onClose} width={620}>
            <div style={{ margin: "-16px -16px 0" }}>
                <StepStrip current={step} />
            </div>
            <div style={{ paddingTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
                {error && <ErrorBanner>{error}</ErrorBanner>}

                {step === "location" && (
                    <>
                        <label className={shared["login-field"]}>
                            <span>Host</span>
                            <select value={hostId} onChange={(e) => setHostId(e.target.value)}>
                                {servers.map((s) => (
                                    <option key={s.id} value={s.id}>{s.name}{s.status.info ? ` (${s.status.info.primaryIp})` : ""}</option>
                                ))}
                            </select>
                        </label>
                        <label className={shared["login-field"]}>
                            <span>Directory</span>
                            <input value={dir} onChange={(e) => setDir(e.target.value)} spellCheck={false} />
                        </label>
                        {hostId && <DirectoryPicker serverId={hostId} value={dir} onChange={setDir} />}
                        <div className={shared["modal-actions"]} style={{ marginTop: 4 }}>
                            <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                            <button className={cx(shared.btn, shared["btn-primary"])} type="button" disabled={busy || !hostId} onClick={() => void detect()}>
                                {busy ? "Checking…" : "Continue"}
                            </button>
                        </div>
                    </>
                )}

                {step === "detected" && detection && (
                    <>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 12 }}>
                            <span className={shared.mono}>{servers.find((s) => s.id === hostId)?.name ?? hostId} : {dir}</span>
                            <button className={cx(shared.btn, shared["btn-sm"])} style={{ marginLeft: "auto" }} onClick={() => setStep("location")}>Change</button>
                        </div>

                        {detection.composeFound ? (
                            <div style={{ border: "1px solid color-mix(in srgb, var(--ok) 35%, var(--border))", background: "color-mix(in srgb, var(--ok) 7%, var(--panel))", borderRadius: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <span className={cx(shared.badge, shared["badge-ok"])}>compose file found</span>
                                    <span className={shared.dim} style={{ fontSize: 12 }}>
                                        {detection.services.length} service{detection.services.length === 1 ? "" : "s"} · {detection.externalBindMounts.length} bind mount{detection.externalBindMounts.length === 1 ? "" : "s"} · {detection.namedVolumeCount} named volume{detection.namedVolumeCount === 1 ? "" : "s"}
                                    </span>
                                </div>
                                <pre className={shared.mono} style={{ margin: 0 }}>{detection.services.join(" · ") || "—"}</pre>
                            </div>
                        ) : (
                            <ErrorBanner>No compose file found in this directory.</ErrorBanner>
                        )}

                        {detection.composeError && (
                            <div style={{ border: "1px solid color-mix(in srgb, var(--warn) 40%, var(--border))", background: "color-mix(in srgb, var(--warn) 8%, var(--panel))", borderRadius: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
                                <b style={{ color: "var(--warn)" }}>Couldn't read services from the compose file</b>
                                <span className={shared.dim}>{detection.composeError}</span>
                                <span className={shared.dim}>The service count above may show 0 even though the file declares some — you can still import, and the correct count will show once the app is added.</span>
                            </div>
                        )}

                        {!detection.manifestFound && detection.composeFound && (
                            <div style={{ border: "1px solid color-mix(in srgb, var(--warn) 40%, var(--border))", background: "color-mix(in srgb, var(--warn) 8%, var(--panel))", borderRadius: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
                                <b style={{ color: "var(--warn)" }}>No sc-app.json in this directory</b>
                                <span className={shared.dim}>A fresh one will be written with a new id. Project name predicted from the directory — confirm below.</span>
                            </div>
                        )}

                        {detection.externalBindMounts.length > 0 && (
                            <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4 }}>
                                <b>{detection.externalBindMounts.length} bind mount{detection.externalBindMounts.length === 1 ? "" : "s"} point outside this directory</b>
                                <pre className={shared.mono} style={{ margin: 0 }}>
                                    {detection.externalBindMounts.map((m) => `${m.source} → ${m.target}`).join("\n")}
                                </pre>
                                <span className={shared.dim}>They stay where they are — the Volumes tab only browses <b>volumes/</b>.</span>
                            </div>
                        )}

                        <label className={shared["login-field"]}>
                            <span>App name</span>
                            <input value={name} onChange={(e) => setName(e.target.value)} />
                        </label>

                        <div className={shared["modal-actions"]} style={{ marginTop: 4 }}>
                            <button className={shared.btn} type="button" onClick={() => setStep("location")}>Back</button>
                            <button
                                className={cx(shared.btn, shared["btn-primary"])}
                                type="button"
                                disabled={!detection.composeFound || !name.trim()}
                                onClick={() => setStep("confirm")}
                            >
                                Continue
                            </button>
                        </div>
                    </>
                )}

                {step === "confirm" && detection && (
                    <>
                        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 10, rowGap: 8 }}>
                            <span className={shared.dim}>Name</span><span>{name}</span>
                            <span className={shared.dim}>Host</span><span>{servers.find((s) => s.id === hostId)?.name ?? hostId}</span>
                            <span className={shared.dim}>Directory</span><span className={shared.mono}>{dir}</span>
                            <span className={shared.dim}>Services</span><span>{detection.services.length}</span>
                        </div>
                        <div className={shared["modal-actions"]} style={{ marginTop: 4 }}>
                            <button className={shared.btn} type="button" onClick={() => setStep("detected")}>Back</button>
                            <button className={cx(shared.btn, shared["btn-primary"])} type="button" disabled={busy} onClick={() => void doImport()}>
                                {busy ? "Importing…" : "Import"}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
}
