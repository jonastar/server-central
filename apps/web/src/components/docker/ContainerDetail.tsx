import { useEffect, useState } from "react";
import type { DockerContainerDetail } from "@central/shared";
import { api } from "../../api";
import { cx } from "../../utils";
import { EmptyState, ErrorBanner, Modal } from "../ui";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="detail-row">
            <div className="detail-label">{label}</div>
            <div className="detail-value">{children}</div>
        </div>
    );
}

export function ContainerDetail({ serverId, containerId, name, onClose, onShowLogs }: {
    serverId: string;
    containerId: string;
    name: string;
    onClose: () => void;
    onShowLogs: () => void;
}) {
    const [detail, setDetail] = useState<DockerContainerDetail | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<"details" | "raw">("details");

    useEffect(() => {
        let alive = true;
        api("dockerContainerInspect", { serverId, containerId })
            .then((d) => alive && setDetail(d))
            .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
        return () => { alive = false; };
    }, [serverId, containerId]);

    return (
        <Modal title={`Container — ${name}`} onClose={onClose} width={820}>
            <div className="sub-tabs" style={{ marginBottom: 12 }}>
                <button className={cx("sub-tab", tab === "details" && "active")} onClick={() => setTab("details")}>Details</button>
                <button className={cx("sub-tab", tab === "raw" && "active")} onClick={() => setTab("raw")}>Raw</button>
                <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onShowLogs}>Logs</button>
            </div>

            {error && <ErrorBanner>{error}</ErrorBanner>}
            {!detail && !error && <EmptyState>Loading…</EmptyState>}

            {detail && tab === "details" && (
                <div className="detail-grid">
                    <Row label="State">{detail.state} ({detail.status})</Row>
                    <Row label="Image">{detail.image}</Row>
                    <Row label="Command"><span className="mono">{detail.command || "—"}</span></Row>
                    <Row label="Restart">{detail.restartPolicy}</Row>
                    <Row label="Networks">{detail.networks.join(", ") || "—"}</Row>
                    <Row label="Ports">
                        {detail.ports.length === 0 ? "—" : (
                            <ul className="detail-list mono">{detail.ports.map((p) => <li key={p}>{p}</li>)}</ul>
                        )}
                    </Row>
                    <Row label="Mounts">
                        {detail.mounts.length === 0 ? "—" : (
                            <ul className="detail-list mono">
                                {detail.mounts.map((m) => <li key={m.destination}>{m.source} → {m.destination} <span className="dim">({m.type})</span></li>)}
                            </ul>
                        )}
                    </Row>
                    <Row label="Env">
                        {detail.env.length === 0 ? "—" : (
                            <ul className="detail-list mono">{detail.env.map((e) => <li key={e}>{e}</li>)}</ul>
                        )}
                    </Row>
                </div>
            )}

            {detail && tab === "raw" && <pre className="logs-pre">{detail.raw}</pre>}
        </Modal>
    );
}
