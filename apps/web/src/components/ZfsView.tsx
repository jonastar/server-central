import type { ZfsSection } from "../routes";
import { cx } from "../utils";
import { ZfsPools } from "./zfs/ZfsPools";
import { ZfsDatasets } from "./zfs/ZfsDatasets";
import { ZfsSnapshots } from "./zfs/ZfsSnapshots";
import shared from "../styles/shared.module.css";

export interface ZfsNav {
    zfsSection?: ZfsSection;
}

const SECTIONS: Array<{ id: ZfsSection; label: string }> = [
    { id: "pools", label: "Pools" },
    { id: "datasets", label: "Datasets" },
    { id: "snapshots", label: "Snapshots" },
];

export function ZfsView({ serverId, section, onNavigate }: {
    serverId: string;
    section: ZfsSection;
    onNavigate: (next: ZfsNav) => void;
}) {
    return (
        <div className={shared.view}>
            <header className={shared["view-header"]}>
                <h1>ZFS</h1>
            </header>
            <nav className={shared["sub-tabs"]}>
                {SECTIONS.map((s) => (
                    <button
                        key={s.id}
                        className={cx(shared["sub-tab"], section === s.id && shared.active)}
                        onClick={() => onNavigate({ zfsSection: s.id })}
                    >
                        {s.label}
                    </button>
                ))}
            </nav>

            {section === "pools" && <ZfsPools serverId={serverId} />}
            {section === "datasets" && <ZfsDatasets serverId={serverId} />}
            {section === "snapshots" && <ZfsSnapshots serverId={serverId} />}
        </div>
    );
}
