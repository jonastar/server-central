import { useState } from "react";
import type { ComposeStack, ServerEntry } from "@central/shared";
import { api } from "../api";
import { runTaskAndWait } from "../taskRun";
import { cx } from "../utils";
import { ErrorBanner, Modal } from "./ui";
import shared from "../styles/shared.module.css";

/**
 * Removing a compose stack, as two separate outcomes rather than one action
 * with a checkbox:
 *
 * - **Unregister** — SC forgets the stack; the folder stays exactly where it is
 *   and can be imported again later. When containers are running this takes them
 *   down first: a stack left running with nothing managing it is the one outcome
 *   nobody asks for, and the host's stacks section would adopt it straight back
 *   on the next read anyway (see HostComposeStacks).
 * - **Delete folder** — the directory and everything in it goes. Irreversible,
 *   so it needs the stack's name typed, and it also takes containers down first
 *   (deleting a compose file out from under running containers leaves them
 *   orphaned with no way to address them).
 */
export function DeleteComposeStackModal({ stack, host, running, onClose, onDeleted }: {
    stack: ComposeStack;
    host: ServerEntry | undefined;
    /** Whether any of this stack's containers currently exist — decides whether
     *  removal has to run `down` first, and how the actions are labelled. */
    running: boolean;
    onClose: () => void;
    onDeleted: () => void;
}) {
    const [confirmName, setConfirmName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<"unregister" | "delete" | null>(null);

    const hostLabel = host ? `${host.name} (${stack.hostId})` : stack.hostId;
    const nameTyped = confirmName.trim() === stack.name;

    async function remove(deleteDir: boolean) {
        setError(null);
        setBusy(deleteDir ? "delete" : "unregister");
        try {
            if (running) {
                await runTaskAndWait({ kind: "docker_compose_action", stackId: stack.id, action: "down" }, stack.hostId);
            }
            await api("deleteComposeStack", { stackId: stack.id, deleteDir });
            onDeleted();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setBusy(null);
        }
    }

    return (
        <Modal title={`Remove "${stack.name}"`} onClose={onClose} width={520}>
            {error && <ErrorBanner>{error}</ErrorBanner>}

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                    <div>
                        <b>{running ? "Down and unregister" : "Unregister"}</b>
                        <br />
                        <span className={shared.dim} style={{ fontSize: 12 }}>
                            {running
                                ? <>Containers are stopped and removed, then Server Central forgets the stack. </>
                                : <>Server Central forgets the stack. </>}
                            <span className={shared.mono}>{stack.dir}</span> is left on <b>{hostLabel}</b> untouched — import it again to bring it back.
                        </span>
                    </div>
                    <button
                        className={cx(shared.btn, shared["btn-sm"])}
                        type="button"
                        style={{ alignSelf: "flex-start" }}
                        disabled={busy !== null}
                        onClick={() => void remove(false)}
                    >
                        {busy === "unregister"
                            ? (running ? "Taking down…" : "Unregistering…")
                            : (running ? "Down and unregister" : "Unregister")}
                    </button>
                </div>

                <div style={{ border: "1px solid color-mix(in srgb, var(--err) 40%, var(--border))", borderRadius: 6, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                    <div>
                        <b style={{ color: "var(--err)" }}>Delete folder</b>
                        <br />
                        <span className={shared.dim} style={{ fontSize: 12 }}>
                            {running && <>Containers are taken down first, then </>}
                            <span className={shared.mono}>{stack.dir}</span> is permanently removed from <b>{hostLabel}</b>, including anything stored inside it. This cannot be undone.
                        </span>
                    </div>
                    <label className={shared["login-field"]}>
                        <span>Type <b>{stack.name}</b> to confirm</span>
                        <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} spellCheck={false} />
                    </label>
                    <button
                        className={cx(shared.btn, shared["btn-sm"], shared["btn-danger"])}
                        type="button"
                        style={{ alignSelf: "flex-start" }}
                        disabled={busy !== null || !nameTyped}
                        onClick={() => void remove(true)}
                    >
                        {busy === "delete" ? "Deleting…" : "Delete folder"}
                    </button>
                </div>
            </div>

            <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                <button className={shared.btn} type="button" onClick={onClose} disabled={busy !== null}>Cancel</button>
            </div>
        </Modal>
    );
}
