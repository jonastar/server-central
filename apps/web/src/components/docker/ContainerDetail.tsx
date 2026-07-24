import { useEffect, useState } from "react";
import type { DockerContainerDetail } from "@central/shared";
import { api } from "../../api";
import { cx } from "../../utils";
import { DetailPair, EmptyState, ErrorBanner, Modal } from "../ui";
import shared from "../../styles/shared.module.css";

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
            <div className={shared["sub-tabs"]} style={{ marginBottom: 12 }}>
                <button className={cx(shared["sub-tab"], tab === "details" && shared.active)} onClick={() => setTab("details")}>Details</button>
                <button className={cx(shared["sub-tab"], tab === "raw" && shared.active)} onClick={() => setTab("raw")}>Raw</button>
                <button className={cx(shared.btn, shared["btn-sm"])} style={{ marginLeft: "auto" }} onClick={onShowLogs}>Logs</button>
            </div>

            {error && <ErrorBanner>{error}</ErrorBanner>}
            {!detail && !error && <EmptyState>Loading…</EmptyState>}

            {detail && tab === "details" && (
                <div className={shared["detail-grid"]}>
                    <DetailPair label="State">{detail.state} ({detail.status})</DetailPair>
                    <DetailPair label="Image">{detail.image}</DetailPair>
                    <DetailPair label="Command"><span className={shared.mono}>{detail.command || "—"}</span></DetailPair>
                    <DetailPair label="Restart">{detail.restartPolicy}</DetailPair>
                    <DetailPair label="Networks">{detail.networks.join(", ") || "—"}</DetailPair>
                    <DetailPair label="Ports">
                        {detail.ports.length === 0 ? "—" : (
                            <ul className={cx(shared["detail-list"], shared.mono)}>{detail.ports.map((p) => <li key={p}>{p}</li>)}</ul>
                        )}
                    </DetailPair>
                    <DetailPair label="Mounts">
                        {detail.mounts.length === 0 ? "—" : (
                            <ul className={cx(shared["detail-list"], shared.mono)}>
                                {detail.mounts.map((m) => <li key={m.destination}>{m.source} → {m.destination} <span className={shared.dim}>({m.type})</span></li>)}
                            </ul>
                        )}
                    </DetailPair>
                    <DetailPair label="Env">
                        {detail.env.length === 0 ? "—" : (
                            <ul className={cx(shared["detail-list"], shared.mono)}>{detail.env.map((e) => <li key={e}>{e}</li>)}</ul>
                        )}
                    </DetailPair>
                    <DetailPair label="Labels">
                        {detail.labels.length === 0 ? "—" : (
                            <ul className={cx(shared["detail-list"], shared.mono)}>
                                {detail.labels.map((l) => <li key={l.key}>{l.key}=<span className={shared.dim}>{l.value}</span></li>)}
                            </ul>
                        )}
                    </DetailPair>
                </div>
            )}

            {detail && tab === "raw" && <pre className={shared["logs-pre"]}>{detail.raw}</pre>}
        </Modal>
    );
}
