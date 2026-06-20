import { useState, useEffect, useCallback } from "react";
import { Modal } from "./ui";
import { api } from "../api";

type Platform = "linux" | "mac" | "windows";

const PLATFORM_LABELS: Record<Platform, string> = {
    linux: "Linux",
    mac: "macOS",
    windows: "Windows",
};

export function AddNodeModal({ onClose }: { onClose: () => void }) {
    const [platform, setPlatform] = useState<Platform>("linux");
    const [command, setCommand] = useState<string | null>(null);
    const [expiresAt, setExpiresAt] = useState<number | null>(null);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

    const generate = useCallback(async (p: Platform) => {
        setLoading(true);
        setError(null);
        setCommand(null);
        setCopied(false);
        try {
            const result = await api("generateNodeInstallCommand", { platform: p });
            setCommand(result.command);
            setExpiresAt(result.expiresAt);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void generate(platform); }, []);

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
        void generate(p);
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

            <div className="modal-actions" style={{ marginTop: 16 }}>
                <button className="btn" onClick={onClose}>Close</button>
            </div>
        </Modal>
    );
}
