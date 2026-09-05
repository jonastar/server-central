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

/** Design ref 1k: single modal, path preview as you type. "Empty" and "Paste
 *  YAML" are wired; "From template…" waits on a template catalogue
 *  (doc/idea_app_system.md), which is a feature of its own, not a mode of this
 *  modal. The host isn't a field: this opens from one host's Docker → Stacks
 *  section, and that's the host.
 *
 *  Pasted YAML isn't validated before create — `docker compose config` needs the
 *  file on the host, and the stack view's editor runs exactly that check the
 *  moment the stack opens, with somewhere to fix it. */
export function NewComposeStackModal({ host, onClose, onCreated }: {
    host: ServerEntry;
    onClose: () => void;
    onCreated: (stackId: string) => void;
}) {
    const [name, setName] = useState("");
    const hostId = host.id;
    const [baseDir, setBaseDir] = useState("/opt/sc-apps");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [source, setSource] = useState<"empty" | "yaml">("empty");
    const [yaml, setYaml] = useState("");

    const slug = slugify(name) || "stack";
    const targetDir = joinDir(baseDir, slug);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        if (!name.trim()) {
            setError("Name is required");
            return;
        }
        if (source === "yaml" && !yaml.trim()) {
            setError("Paste a compose file, or switch to Empty");
            return;
        }
        setBusy(true);
        try {
            const stack = await api("compose", "create", {
                name,
                hostId,
                dir: targetDir,
                content: source === "yaml" ? yaml : undefined,
            });
            onCreated(stack.id);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="New compose stack" onClose={onClose} width={560}>
            <form onSubmit={handleSubmit}>
                {error && <ErrorBanner>{error}</ErrorBanner>}

                <label className={shared["login-field"]}>
                    <span>Name</span>
                    <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="jellyfin" />
                </label>

                <label className={shared["login-field"]} style={{ marginTop: 10 }}>
                    <span>Host</span>
                    <span className={shared.dim} style={{ fontSize: 12.5 }}>
                        {host.name}{host.status.info ? ` (${host.status.info.primaryIp})` : ""}
                    </span>
                </label>

                <label className={shared["login-field"]} style={{ marginTop: 10 }}>
                    <span>Base directory</span>
                    <input value={baseDir} onChange={(e) => setBaseDir(e.target.value)} spellCheck={false} />
                </label>
                <div style={{ marginTop: 6 }}>
                    <DirectoryPicker serverId={hostId} value={baseDir} onChange={setBaseDir} />
                </div>

                <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "10px 12px", marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--muted)" }}>Will create</span>
                    <pre className={shared.mono} style={{ margin: 0, lineHeight: 1.6 }}>
                        {targetDir}/{"\n"}  sc-stack.json{"\n"}  compose.yaml{source === "yaml" ? " (from the YAML below)" : ""}
                    </pre>
                </div>

                <label className={shared["login-field"]} style={{ marginTop: 12 }}>
                    <span>Compose file</span>
                    <div style={{ display: "flex", gap: 6 }}>
                        <button
                            type="button"
                            className={cx(shared.btn, source === "empty" && shared["btn-primary"])}
                            onClick={() => setSource("empty")}
                        >
                            Empty
                        </button>
                        <button type="button" className={shared.btn} disabled title="Coming soon">From template…</button>
                        <button
                            type="button"
                            className={cx(shared.btn, source === "yaml" && shared["btn-primary"])}
                            onClick={() => setSource("yaml")}
                        >
                            Paste YAML
                        </button>
                    </div>
                </label>

                {source === "yaml" && (
                    <textarea
                        className={shared.mono}
                        value={yaml}
                        onChange={(e) => setYaml(e.target.value)}
                        spellCheck={false}
                        rows={12}
                        placeholder={"services:\n  app:\n    image: nginx:latest\n    ports:\n      - \"8080:80\""}
                        style={{ width: "100%", marginTop: 8, fontSize: 12.5, resize: "vertical" }}
                    />
                )}

                <div className={shared["modal-actions"]} style={{ marginTop: 16, alignItems: "center" }}>
                    <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                    <button className={cx(shared.btn, shared["btn-primary"])} type="submit" disabled={busy}>
                        {busy ? "Creating…" : "Create compose stack"}
                    </button>
                    <span className={shared.dim} style={{ marginLeft: "auto", fontSize: 12 }}>
                        Nothing is started until you run <b>Up</b>.
                    </span>
                </div>
            </form>
        </Modal>
    );
}
