import { useState } from "react";
import type { App, ServerEntry } from "@central/shared";
import { api } from "../api";
import { cx } from "../utils";
import { ErrorBanner, Modal } from "./ui";
import shared from "../styles/shared.module.css";

/** Confirms removing an App from Server Central, with an explicit choice of
 *  what happens to its directory on the host: left alone, or deleted along
 *  with it (compose file, manifest, volumes/ — everything). Deleting the
 *  folder is irreversible, so that path also requires typing the app name. */
export function DeleteAppModal({ app, host, onClose, onDeleted }: {
    app: App;
    host: ServerEntry | undefined;
    onClose: () => void;
    onDeleted: () => void;
}) {
    const [deleteDir, setDeleteDir] = useState(false);
    const [confirmName, setConfirmName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const hostLabel = host ? `${host.name} (${app.hostId})` : app.hostId;
    const needsConfirm = deleteDir && confirmName.trim() !== app.name;

    async function handleDelete() {
        setError(null);
        setBusy(true);
        try {
            await api("deleteApp", { appId: app.id, deleteDir });
            onDeleted();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setBusy(false);
        }
    }

    return (
        <Modal title={`Remove "${app.name}"`} onClose={onClose} width={520}>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            <p style={{ margin: "0 0 12px" }}>
                This removes the app from Server Central. Its containers are not stopped —
                take it down first if you don't want it running unmanaged.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", border: "1px solid var(--border)", borderRadius: 6, padding: "10px 12px" }}>
                    <input type="radio" checked={!deleteDir} onChange={() => setDeleteDir(false)} style={{ marginTop: 3 }} />
                    <span>
                        <b>Keep the folder</b>
                        <br />
                        <span className={shared.dim} style={{ fontSize: 12 }}>
                            <span className={shared.mono}>{app.dir}</span> is left on <b>{hostLabel}</b> untouched — re-import it later to bring it back.
                        </span>
                    </span>
                </label>
                <label style={{ display: "flex", gap: 8, alignItems: "flex-start", border: "1px solid color-mix(in srgb, var(--err) 40%, var(--border))", borderRadius: 6, padding: "10px 12px" }}>
                    <input type="radio" checked={deleteDir} onChange={() => setDeleteDir(true)} style={{ marginTop: 3 }} />
                    <span>
                        <b style={{ color: "var(--err)" }}>Delete the folder</b>
                        <br />
                        <span className={shared.dim} style={{ fontSize: 12 }}>
                            <span className={shared.mono}>{app.dir}</span> is permanently removed from <b>{hostLabel}</b>, including <b>volumes/</b>. This cannot be undone.
                        </span>
                    </span>
                </label>
            </div>

            {deleteDir && (
                <label className={shared["login-field"]} style={{ marginTop: 12 }}>
                    <span>Type <b>{app.name}</b> to confirm</span>
                    <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoFocus spellCheck={false} />
                </label>
            )}

            <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                <button className={cx(shared.btn, shared["btn-danger"])} type="button" disabled={busy || needsConfirm} onClick={() => void handleDelete()}>
                    {busy ? "Removing…" : deleteDir ? "Delete folder & remove app" : "Remove app"}
                </button>
            </div>
        </Modal>
    );
}
