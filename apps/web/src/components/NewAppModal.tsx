import { useState } from "react";
import type { ServerEntry } from "@central/shared";
import { api } from "../api";
import { cx } from "../utils";
import { DirectoryPicker } from "./DirectoryPicker";
import { ErrorBanner, Modal } from "./ui";
import shared from "../styles/shared.module.css";

function slugify(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function joinDir(dir: string, name: string): string {
    return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** Design ref 1k: single modal, path preview as you type. Only "Empty" compose
 *  choice is wired — "From template…"/"Paste YAML" are nice-to-have per
 *  doc/idea_app_system.md, not required for v1. */
export function NewAppModal({ servers, hostId: initialHostId, onClose, onCreated }: {
    servers: ServerEntry[];
    hostId?: string;
    onClose: () => void;
    onCreated: (appId: string) => void;
}) {
    const [name, setName] = useState("");
    const [hostId, setHostId] = useState(initialHostId ?? servers[0]?.id ?? "");
    const [baseDir, setBaseDir] = useState("/opt/sc-apps");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const slug = slugify(name) || "app";
    const targetDir = joinDir(baseDir, slug);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        if (!name.trim()) {
            setError("Name is required");
            return;
        }
        if (!hostId) {
            setError("Choose a host");
            return;
        }
        setBusy(true);
        try {
            const app = await api("createApp", { name, hostId, dir: targetDir });
            onCreated(app.id);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="New App" onClose={onClose} width={560}>
            <form onSubmit={handleSubmit}>
                {error && <ErrorBanner>{error}</ErrorBanner>}

                <label className={shared["login-field"]}>
                    <span>Name</span>
                    <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="jellyfin" />
                </label>

                <label className={shared["login-field"]} style={{ marginTop: 10 }}>
                    <span>Host</span>
                    <select value={hostId} onChange={(e) => setHostId(e.target.value)}>
                        {servers.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}{s.status.info ? ` (${s.status.info.primaryIp})` : ""}</option>
                        ))}
                    </select>
                </label>

                <label className={shared["login-field"]} style={{ marginTop: 10 }}>
                    <span>Base directory</span>
                    <input value={baseDir} onChange={(e) => setBaseDir(e.target.value)} spellCheck={false} />
                </label>
                {hostId && (
                    <div style={{ marginTop: 6 }}>
                        <DirectoryPicker serverId={hostId} value={baseDir} onChange={setBaseDir} />
                    </div>
                )}

                <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "10px 12px", marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)" }}>Will create</span>
                    <pre className={shared.mono} style={{ margin: 0, lineHeight: 1.6 }}>
                        {targetDir}/{"\n"}  sc-app.json{"\n"}  compose.yaml{"\n"}  volumes/
                    </pre>
                </div>

                <label className={shared["login-field"]} style={{ marginTop: 12 }}>
                    <span>Compose file</span>
                    <div style={{ display: "flex", gap: 6 }}>
                        <button type="button" className={cx(shared.btn, shared["btn-primary"])}>Empty</button>
                        <button type="button" className={shared.btn} disabled title="Coming soon">From template…</button>
                        <button type="button" className={shared.btn} disabled title="Coming soon">Paste YAML</button>
                    </div>
                </label>

                <div className={shared["modal-actions"]} style={{ marginTop: 16, alignItems: "center" }}>
                    <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                    <button className={cx(shared.btn, shared["btn-primary"])} type="submit" disabled={busy}>
                        {busy ? "Creating…" : "Create App"}
                    </button>
                    <span className={shared.dim} style={{ marginLeft: "auto", fontSize: 12 }}>
                        Nothing is started until you run <b>Up</b>.
                    </span>
                </div>
            </form>
        </Modal>
    );
}
