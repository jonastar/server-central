import { useEffect, useState } from "react";
import type { AgentConfigReport, ServerEntry } from "@central/shared";
import { api } from "../api";
import { useCan } from "../hooks/usePermissions";
import { cx, fmtDateTime } from "../utils";
import { DetailPair, ErrorBanner, Modal } from "./ui";
import { LogViewerModal } from "./LogViewerModal";
import shared from "../styles/shared.module.css";

/** A value that may be absent, rendered as a dash rather than an empty cell. */
function Value({ children, mono }: { children: string | null; mono?: boolean }) {
    if (!children) {
        return <span className={shared.dim}>—</span>;
    }
    return <span className={mono ? shared.mono : undefined} style={{ overflowWrap: "anywhere" }}>{children}</span>;
}

/**
 * How one agent is actually running, read from the agent rather than from what
 * the control plane remembers about installing it — the two can disagree, and
 * when they do this is the side that's true.
 *
 * The report never carries the agent's durable token (see `AgentConfigReport`),
 * so this is a plain read-only panel with no reveal/redact affordance to get
 * wrong. Its one action is the journal shortcut, which is just the systemd log
 * endpoint pointed at the unit the agent reports.
 *
 * The embedded agent is included rather than excluded: it has no endpoint, cert
 * or token of its own, and reports the control plane's install instead — which
 * is the honest answer to "how is the agent on this host configured", since on
 * that host the agent *is* the control plane.
 */
export function AgentConfigModal({ entry, onClose }: { entry: ServerEntry; onClose: () => void }) {
    const [config, setConfig] = useState<AgentConfigReport | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [showLogs, setShowLogs] = useState(false);
    const can = useCan();

    useEffect(() => {
        let cancelled = false;
        api("servers", "getAgentConfig", { serverId: entry.id })
            .then((res) => { if (!cancelled) { setConfig(res); } })
            .catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : String(err)); } });
        return () => { cancelled = true; };
    }, [entry.id]);

    const logUnit = config?.logUnit ?? null;
    const canReadLogs = logUnit !== null && can("panel.systemd.read");
    // The embedded agent's report describes the control plane, so the fields
    // about dialing one (endpoints, cert, config file) are all null by nature —
    // rows of dashes that would read as missing data rather than as "n/a".
    const embedded = config?.mode === "embedded";

    return (
        <>
            <Modal title={`Agent config — ${entry.name}`} onClose={onClose} width={620}>
                {error && <ErrorBanner>{error}</ErrorBanner>}

                {!error && !config && <p className={shared.dim} style={{ margin: 0 }}>Reading config from the agent…</p>}

                {config && (
                    <>
                        <DetailPair label="Mode">
                            {config.mode}
                            {embedded && (
                                <span className={shared.dim}> — runs inside the control plane on this host, so it dials nothing and needs no credential of its own.</span>
                            )}
                        </DetailPair>
                        <DetailPair label="Supervision">
                            <Value>{config.mechanism}</Value>
                            {config.mechanism === null && config.mode === "live" && (
                                <span className={shared.dim}> — nothing supervises a live agent; it stops when its process does.</span>
                            )}
                        </DetailPair>
                        {!embedded && (
                            <>
                                <DetailPair label="Config file">
                                    <Value mono>{config.configPath}</Value>
                                    {config.configPath === null && (
                                        <span className={shared.dim}> — started from command-line flags, with no file to edit.</span>
                                    )}
                                </DetailPair>
                                <DetailPair label="Control plane"><Value mono>{config.control}</Value></DetailPair>
                                <DetailPair label="Alternate"><Value mono>{config.altControl}</Value></DetailPair>
                                <DetailPair label="Last connected via">
                                    <Value mono>{config.lastControl}</Value>
                                    {config.lastControlAt !== null && (
                                        <span className={shared.dim}> · {fmtDateTime(config.lastControlAt)}</span>
                                    )}
                                </DetailPair>
                                <DetailPair label="Certificate"><Value mono>{config.cert}</Value></DetailPair>
                            </>
                        )}
                        <DetailPair label="Install dir"><Value mono>{config.installDir}</Value></DetailPair>
                        <DetailPair label="Data dir"><Value mono>{config.dataDir}</Value></DetailPair>
                        <DetailPair label="Unit"><Value mono>{config.logUnit}</Value></DetailPair>

                        <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}>
                            {canReadLogs && (
                                <button className={shared.btn} type="button" onClick={() => setShowLogs(true)}>
                                    View agent logs
                                </button>
                            )}
                            <span className={cx(shared.dim)} style={{ fontSize: 12 }}>
                                {logUnit === null
                                    ? "No journal for this agent — it isn't running under a systemd unit."
                                    : canReadLogs
                                        ? <>Reads <code>{logUnit}</code> on this host.</>
                                        : "Reading the agent's journal needs the systemd view permission."}
                            </span>
                        </div>

                        <p className={shared.dim} style={{ fontSize: 12, marginTop: 14, marginBottom: 0 }}>
                            {embedded
                                ? "The control plane's own install, since that is what the agent on this host runs inside."
                                : "Read from the agent itself. The durable token that authenticates this agent lives in the same config file and is deliberately not shown."}
                        </p>
                    </>
                )}
            </Modal>

            {showLogs && canReadLogs && (
                <LogViewerModal
                    title={`Agent logs — ${entry.name} (${logUnit})`}
                    onClose={() => setShowLogs(false)}
                    caps={{ priority: true }}
                    fetchLogs={(q) => api("systemd", "serviceLogs", { serverId: entry.id, unit: logUnit, ...q }).then((r) => r.logs)}
                />
            )}
        </>
    );
}
