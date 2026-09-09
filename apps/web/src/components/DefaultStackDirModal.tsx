import { useEffect, useState } from "react";
import { FALLBACK_STACK_DIR, type ServerEntry } from "@central/shared";
import { api } from "../api";
import { cx } from "../utils";
import { DirectoryPicker } from "./DirectoryPicker";
import { ErrorBanner, Modal } from "./ui";
import shared from "../styles/shared.module.css";

/**
 * Where this host's new/import stack dialogs should start. Per host rather than
 * fleet-wide, because that's where the answer differs — one box keeps stacks on
 * a pool dataset, another under /opt.
 *
 * A preference about stacks that don't exist yet: every existing stack recorded
 * its own directory when it was created or imported, and nothing here moves one.
 * The copy says so, since "default" is exactly the word people expect to also
 * apply retroactively.
 */
export function DefaultStackDirModal({ host, onClose }: {
    host: ServerEntry;
    onClose: () => void;
}) {
    const [dir, setDir] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        api("compose", "getDefaultDir", { hostId: host.id })
            .then((res) => { if (!cancelled) { setDir(res.dir); } })
            .catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : String(err)); } });
        return () => { cancelled = true; };
    }, [host.id]);

    async function save(value: string | null) {
        setBusy(true);
        setError(null);
        try {
            // Adopt what the server stored — it normalizes (a trailing slash is
            // stripped), so what's shown next time matches what was saved.
            const res = await api("compose", "setDefaultDir", { hostId: host.id, dir: value });
            setDir(res.dir);
            // Nothing on the page reads this — the two dialogs fetch it when they
            // open — so there is no list to refresh, only the modal to close.
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title={`Default stack directory — ${host.name}`} onClose={onClose} width={560}>
            <form onSubmit={(e) => { e.preventDefault(); void save(dir?.trim() || null); }}>
                {error && <ErrorBanner>{error}</ErrorBanner>}

                <p className={shared.dim} style={{ margin: "0 0 12px", fontSize: 13 }}>
                    Where <b>New compose stack</b> and <b>Import existing</b> start from on this host.
                    Both dialogs still let you browse elsewhere.
                </p>
                <p className={shared.dim} style={{ margin: "0 0 12px", fontSize: 12 }}>
                    Only a starting point — stacks that already exist keep the directory they were
                    created or imported with, and nothing here moves them. Clearing the field falls
                    back to <code>{FALLBACK_STACK_DIR}</code>.
                </p>

                <label className={shared["login-field"]}>
                    <span>Directory</span>
                    <input
                        autoFocus
                        value={dir ?? ""}
                        placeholder={FALLBACK_STACK_DIR}
                        onChange={(e) => { setDir(e.target.value); setError(null); }}
                        spellCheck={false}
                    />
                </label>
                <div style={{ marginTop: 6 }}>
                    <DirectoryPicker serverId={host.id} value={dir ?? FALLBACK_STACK_DIR} onChange={setDir} />
                </div>

                <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                    <button className={shared.btn} type="button" onClick={onClose}>Cancel</button>
                    <button className={shared.btn} type="button" disabled={busy} onClick={() => void save(null)}>
                        Reset to default
                    </button>
                    <button className={cx(shared.btn, shared["btn-primary"])} type="submit" disabled={busy || dir === null}>
                        {busy ? "Saving…" : "Save"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
