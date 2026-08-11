import { useState } from "react";
import type { InstallMechanism, ServerEntry } from "@central/shared";
import { Modal } from "./ui";
import { DirectoryPicker } from "./DirectoryPicker";
import { api } from "../api";
import { cx, copyToClipboard } from "../utils";
import shared from "../styles/shared.module.css";
import uiStyles from "./ui.module.css";
import { colorVars } from "../styles/colorVars";

const FALLBACK_INSTALL_DIR = "/usr/local/bin";
const FALLBACK_DATA_DIR = "/var/lib/sc-agent";

/**
 * Guided promotion of a live agent to a permanent service. On a normal host it
 * offers a one-click systemd install to the default paths; when the agent reports
 * the defaults are unusable (read-only root / noexec, e.g. TrueNAS) — or the user
 * chooses to customize — it browses for install + data dirs and, for the manual
 * mechanism, returns a start command to wire into the host's own init system.
 */
export function SetupWizard({ entry, onClose }: { entry: ServerEntry; onClose: () => void }) {
    const install = entry.status.info?.install;
    const defaultsUsable = install?.defaultsUsable ?? false;
    const defaultInstallDir = install?.defaultInstallDir ?? FALLBACK_INSTALL_DIR;
    const defaultDataDir = install?.defaultDataDir ?? FALLBACK_DATA_DIR;

    const [custom, setCustom] = useState(!defaultsUsable);
    const [installDir, setInstallDir] = useState(defaultInstallDir);
    const [dataDir, setDataDir] = useState(defaultDataDir);
    const [mechanism, setMechanism] = useState<InstallMechanism>(defaultsUsable ? "systemd" : "manual");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [force, setForce] = useState(false);
    const [startCommand, setStartCommand] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const alreadyInstalled = error?.toLowerCase().includes("already installed") ?? false;

    async function submit() {
        setBusy(true);
        setError(null);
        try {
            const res = await api("installNodeService", {
                serverId: entry.id,
                installDir: custom ? installDir : null,
                dataDir: custom ? dataDir : null,
                mechanism: custom ? mechanism : "systemd",
                force,
            });
            if (res.startCommand) {
                setStartCommand(res.startCommand);
            } else {
                onClose();
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    // Final step: manual mechanism — show the command to wire into the init system.
    if (startCommand) {
        return (
            <Modal title={`Finish setup on ${entry.name}`} onClose={onClose} width={640}>
                <p style={{ marginTop: 0, color: colorVars.muted }}>
                    The agent is installed and has been started. To make it survive reboots, add this
                    command to your host's init system (e.g. a TrueNAS <strong>Init/Shutdown</strong> POSTINIT
                    script, or a cron <code>@reboot</code> entry):
                </p>
                <div className={shared["add-node-command-wrap"]}>
                    <pre className={shared["add-node-command"]}>{startCommand}</pre>
                    <button
                        className={cx(shared.btn, copied && shared["btn-primary"])}
                        style={{ flexShrink: 0 }}
                        onClick={() => {
                            void copyToClipboard(startCommand);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 1500);
                        }}
                    >
                        {copied ? "Copied!" : "Copy"}
                    </button>
                </div>
                <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                    <button className={cx(shared.btn, shared["btn-primary"])} onClick={onClose}>Done</button>
                </div>
            </Modal>
        );
    }

    return (
        <Modal title={`Set up ${entry.name}`} onClose={onClose} width={640}>
            <p style={{ marginTop: 0, color: colorVars.muted }}>
                Promote this live agent to a permanent service that survives reboots and takes over
                from the live connection.
            </p>

            {!custom ? (
                <>
                    <div style={{ fontSize: 13, marginBottom: 8 }}>
                        Install as a <strong>systemd service</strong> using the default locations:
                    </div>
                    <ul style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: 13, color: colorVars.muted }}>
                        <li>Binary: <code>{defaultInstallDir}</code></li>
                        <li>Data (cert, config, state): <code>{defaultDataDir}</code></li>
                    </ul>
                    <button className={shared.btn} onClick={() => setCustom(true)}>Customize paths…</button>
                </>
            ) : (
                <>
                    {!defaultsUsable && (
                        <div className={uiStyles["error-banner"]} style={{ marginBottom: 12 }}>
                            ⚠ The default paths aren't writable/executable on this host (e.g. a read-only OS
                            root or noexec mount). Choose locations on a writable, exec-capable storage pool.
                        </div>
                    )}

                    <label style={{ display: "block", margin: "4px 0 4px", fontSize: 13 }}>Install directory (binary)</label>
                    <DirectoryPicker serverId={entry.id} value={installDir} onChange={setInstallDir} />

                    <label style={{ display: "block", margin: "16px 0 4px", fontSize: 13 }}>Data directory (cert, config, state)</label>
                    <DirectoryPicker serverId={entry.id} value={dataDir} onChange={setDataDir} />

                    <label style={{ display: "block", margin: "16px 0 6px", fontSize: 13 }}>Persistence</label>
                    <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
                        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <input type="radio" checked={mechanism === "systemd"} onChange={() => setMechanism("systemd")} />
                            systemd unit (auto)
                        </label>
                        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <input type="radio" checked={mechanism === "manual"} onChange={() => setMechanism("manual")} />
                            Manual (start command for your init system)
                        </label>
                    </div>

                    {defaultsUsable && (
                        <button className={shared.btn} style={{ marginTop: 12 }} onClick={() => setCustom(false)}>
                            ← Use defaults
                        </button>
                    )}
                </>
            )}

            {error && (
                <div className={uiStyles["error-banner"]} style={{ marginTop: 12 }}>
                    {error}
                    {alreadyInstalled && (
                        <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8, fontWeight: "normal" }}>
                            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                            Force reinstall (overwrites the existing config, cert, and binaries — use this if a
                            previous install is broken)
                        </label>
                    )}
                </div>
            )}

            <div className={shared["modal-actions"]} style={{ marginTop: 16 }}>
                <button className={shared.btn} onClick={onClose} disabled={busy}>Cancel</button>
                <button className={cx(shared.btn, shared["btn-primary"])} onClick={() => void submit()} disabled={busy}>
                    {busy ? "Installing…" : "Install"}
                </button>
            </div>
        </Modal>
    );
}
