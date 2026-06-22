import { useState, useEffect, useCallback, useRef } from "react";
import type { ServerEntry } from "@central/shared";
import { Modal } from "./ui";
import { SetupWizard } from "./SetupWizard";
import { api } from "../api";

type Platform = "linux" | "mac" | "windows";

const PLATFORM_LABELS: Record<Platform, string> = {
    linux: "Linux",
    mac: "macOS",
    windows: "Windows",
};

export function AddNodeModal({ servers, onClose }: { servers: ServerEntry[]; onClose: () => void }) {
    const [platform, setPlatform] = useState<Platform>("linux");
    const [command, setCommand] = useState<string | null>(null);
    const [expiresAt, setExpiresAt] = useState<number | null>(null);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
    const [connected, setConnected] = useState<ServerEntry | null>(null);
    const [setup, setSetup] = useState(false);
    const [useExternal, setUseExternal] = useState(false);
    const [externalHost, setExternalHost] = useState<string | null>(null);

    // Agents present when the modal opened — anything new that connects after is
    // the machine the user just ran the command on.
    const baselineIds = useRef(new Set(servers.map((s) => s.id)));

    // Watch for the freshly-enrolled agent so the user can continue straight to
    // setup instead of hunting for it in the Agents view.
    useEffect(() => {
        if (connected) {
            return;
        }
        const fresh = servers.find(
            (s) => !baselineIds.current.has(s.id) && s.status.state === "online" && s.status.mode === "live",
        );
        if (fresh) {
            setConnected(fresh);
        }
    }, [servers, connected]);

    // Keep the detected entry in sync with live updates (e.g. its info filling in).
    const liveConnected = connected ? servers.find((s) => s.id === connected.id) ?? connected : null;

    const generate = useCallback(async (p: Platform, external: boolean) => {
        setLoading(true);
        setError(null);
        setCommand(null);
        setCopied(false);
        try {
            const result = await api("generateNodeInstallCommand", { platform: p, useExternal: external });
            setCommand(result.command);
            setExpiresAt(result.expiresAt);
            setExternalHost(result.externalHost);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void generate(platform, useExternal); }, []);

    useEffect(() => {
        if (!expiresAt) {
            return;
        }
        const tick = () => setSecondsLeft(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)));
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [expiresAt]);

    function handlePlatformChange(p: Platform) {
        setPlatform(p);
        void generate(p, useExternal);
    }

    function handleExternalToggle(external: boolean) {
        setUseExternal(external);
        void generate(platform, external);
    }

    async function handleCopy() {
        if (!command) {
            return;
        }
        await navigator.clipboard.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }

    const expired = secondsLeft !== null && secondsLeft <= 0;

    // Once the user opts in, hand off to the same wizard the Agents view uses.
    if (setup && liveConnected) {
        return <SetupWizard entry={liveConnected} onClose={onClose} />;
    }

    return (
        <Modal title="Add Node" onClose={onClose} width={640}>
            <p style={{ marginTop: 0, color: "var(--fg-muted)" }}>
                Run this command on the machine you want to add. It downloads the node agent and connects it to this control plane.
            </p>

            <div className="add-node-platforms">
                {(Object.keys(PLATFORM_LABELS) as Platform[]).map((p) => (
                    <button
                        key={p}
                        className={`btn${platform === p ? " btn-primary" : ""}`}
                        onClick={() => handlePlatformChange(p)}
                    >
                        {PLATFORM_LABELS[p]}
                    </button>
                ))}
            </div>

            {externalHost && (
                <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, color: "var(--fg-muted)" }}>
                    <input
                        type="checkbox"
                        checked={useExternal}
                        onChange={(e) => handleExternalToggle(e.target.checked)}
                    />
                    <span>
                        Use external address (<code>{externalHost}</code>) — for a machine that isn't on this network.
                    </span>
                </label>
            )}

            {error && <div className="error-banner" style={{ marginTop: 12 }}>{error}</div>}

            {loading && <div style={{ marginTop: 12, color: "var(--fg-muted)" }}>Generating command…</div>}

            {command && !loading && (
                <>
                    <div className="add-node-command-wrap">
                        <pre className="add-node-command">{command}</pre>
                        <button
                            className={`btn${copied ? " btn-primary" : ""}`}
                            onClick={handleCopy}
                            style={{ flexShrink: 0 }}
                        >
                            {copied ? "Copied!" : "Copy"}
                        </button>
                    </div>
                    {secondsLeft !== null && (
                        <div style={{ marginTop: 8, fontSize: 12, color: expired ? "var(--red)" : "var(--fg-muted)" }}>
                            {expired
                                ? "Token expired — click a platform to generate a new command."
                                : `Token expires in ${Math.floor(secondsLeft / 60)}m ${secondsLeft % 60}s`}
                        </div>
                    )}
                </>
            )}

            {liveConnected && (
                <div className="banner banner-ok" style={{ marginTop: 16 }}>
                    <span>
                        <strong>{liveConnected.name}</strong> connected. Continue to set it up as a permanent service.
                    </span>
                    <button className="btn btn-primary" style={{ marginLeft: "auto" }} onClick={() => setSetup(true)}>
                        Continue setup
                    </button>
                </div>
            )}

            <div className="modal-actions" style={{ marginTop: 16 }}>
                <button className="btn" onClick={onClose}>Close</button>
            </div>
        </Modal>
    );
}
