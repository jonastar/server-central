import { useState } from "react";
import type { DockerSection } from "../routes";
import { cx } from "../utils";
import { DockerOverview } from "./docker/DockerOverview";
import { DockerStacks } from "./docker/DockerStacks";
import { DockerContainers } from "./docker/DockerContainers";
import { DockerVolumes } from "./docker/DockerVolumes";
import { DockerImages } from "./docker/DockerImages";
import { VolumeBrowser } from "./docker/VolumeBrowser";

/** Patch the Docker portion of the route (section + volume-browser drill-down). */
export interface DockerNav {
    section?: DockerSection;
    volume?: string;
    path?: string;
    file?: string;
}

const SECTIONS: Array<{ id: DockerSection; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "stacks", label: "Stacks" },
    { id: "containers", label: "Containers" },
    { id: "volumes", label: "Volumes" },
    { id: "images", label: "Images" },
];

export function DockerView({ serverId, section, volume, path, file, onNavigate }: {
    serverId: string;
    section: DockerSection;
    volume?: string;
    path?: string;
    file: string | null;
    onNavigate: (next: DockerNav) => void;
}) {
    // Filter handed from the Stacks section to the Containers section on drill-in.
    const [containerFilter, setContainerFilter] = useState("");

    function go(next: DockerSection) {
        if (next === "containers") {
            setContainerFilter("");
        }
        onNavigate({ section: next });
    }

    return (
        <div className="view">
            <header className="view-header">
                <h1>Docker</h1>
            </header>
            <nav className="sub-tabs">
                {SECTIONS.map((s) => (
                    <button
                        key={s.id}
                        className={cx("sub-tab", section === s.id && "active")}
                        onClick={() => go(s.id)}
                    >
                        {s.label}
                    </button>
                ))}
            </nav>

            {section === "overview" && <DockerOverview serverId={serverId} />}
            {section === "stacks" && (
                <DockerStacks
                    serverId={serverId}
                    onViewContainers={(project) => {
                        setContainerFilter(project);
                        onNavigate({ section: "containers" });
                    }}
                />
            )}
            {section === "containers" && (
                <DockerContainers serverId={serverId} initialFilter={containerFilter} />
            )}
            {section === "volumes" && !volume && (
                <DockerVolumes
                    serverId={serverId}
                    onBrowse={(name) => onNavigate({ section: "volumes", volume: name })}
                />
            )}
            {section === "volumes" && volume && (
                <VolumeBrowser
                    serverId={serverId}
                    volume={volume}
                    path={path}
                    file={file}
                    onNavigate={(patch) => onNavigate({ section: "volumes", volume, ...patch })}
                    onBack={() => onNavigate({ section: "volumes" })}
                />
            )}
            {section === "images" && <DockerImages serverId={serverId} />}
        </div>
    );
}
