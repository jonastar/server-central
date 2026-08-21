import { useState } from "react";
import type { HostCapability, HostCapabilityResult } from "@central/shared";
import { api } from "../api";
import { EmptyState, ErrorBanner } from "./ui";
import shared from "../styles/shared.module.css";

/**
 * Shown in place of a tab whose host capability the agent reported unavailable.
 *
 * The greyed sidebar item is only a hint — it can't say *why*, and a `disabled`
 * button would be unreachable by keyboard and touch anyway. So the tab stays
 * navigable and lands here, where the agent's own `detail` explains what's
 * missing and the re-check button re-runs the probes without waiting for the
 * agent to reconnect.
 */
export function HostCapabilityNotice({ serverId, capability, label, result }: {
    serverId: string;
    capability: HostCapability;
    label: string;
    result: HostCapabilityResult;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const recheck = async () => {
        setBusy(true);
        setError(null);
        try {
            // The fresh report is broadcast to every client as a servers update,
            // so this view re-renders (and usually unmounts) off that, not off a
            // local copy of the response.
            await api("redetectHostCapabilities", { serverId });
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={shared.view}>
            <header className={shared["view-header"]}>
                <h1>{label}</h1>
            </header>

            {error && <ErrorBanner>{error}</ErrorBanner>}

            <EmptyState>
                <p style={{ margin: "0 0 6px" }}>
                    <strong>{label} isn't available on this host.</strong>
                </p>
                <p style={{ margin: "0 0 16px" }}>
                    {result.detail ?? `The agent reported that ${capability} isn't usable here.`}
                </p>
                <button className={shared.btn} onClick={recheck} disabled={busy}>
                    {busy ? "Re-checking…" : "Re-check"}
                </button>
            </EmptyState>
        </div>
    );
}
