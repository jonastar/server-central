import { useState } from "react";
import type { ServerEntry } from "@central/shared";
import type { ComposeStackTab, DockerSection } from "../routes";
import { cx } from "../utils";
import { DockerOverview } from "./docker/DockerOverview";
import { DockerStacks } from "./docker/DockerStacks";
import { DockerContainers } from "./docker/DockerContainers";
import { DockerVolumes } from "./docker/DockerVolumes";
import { DockerImages } from "./docker/DockerImages";
import { VolumeBrowser } from "./docker/VolumeBrowser";
import { ComposeStackView } from "./ComposeStackView";
import shared from "../styles/shared.module.css";

/** Patch the Docker portion of the route (section + volume-browser and
 *  compose-stack drill-downs). */
export interface DockerNav {
    section?: DockerSection;
    volume?: string;
    path?: string;
    file?: string;
    containerId?: string;
    filter?: string;
    stackId?: string;
    stackTab?: ComposeStackTab;
}

const SECTIONS: Array<{ id: DockerSection; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "stacks", label: "Compose stacks" },
    { id: "containers", label: "Containers" },
    { id: "volumes", label: "Volumes" },
    { id: "images", label: "Images" },
];

export function DockerView({ serverId, section, volume, path, file, filter, containerId, stackId, stackTab, servers, onNavigate }: {
    serverId: string;
    section: DockerSection;
    volume?: string;
    path?: string;
    file: string | null;
    /** Route-carried containers filter (deep links from other views). */
    filter?: string;
    /** Containers section: the container whose detail view is open. */
    containerId?: string;
    /** Stacks section: the registered stack being viewed, if any. */
    stackId?: string;
    stackTab: ComposeStackTab;
    servers: ServerEntry[];
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

    if (section === "stacks" && stackId) {
        return (
            <ComposeStackView
                stackId={stackId}
                tab={stackTab}
                servers={servers}
                onNavigate={(next) => onNavigate({ section: "stacks", stackId, stackTab: next })}
                onBack={() => onNavigate({ section: "stacks" })}
                onOpenContainer={(id, q) => onNavigate({ section: "containers", containerId: id, filter: q })}
            />
        );
    }

    return (
        <div className={shared.view}>
            <header className={shared["view-header"]}>
                <h1>Docker</h1>
            </header>
            <nav className={shared["sub-tabs"]}>
                {SECTIONS.map((s) => (
                    <button
                        key={s.id}
                        className={cx(shared["sub-tab"], section === s.id && shared.active)}
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
                    servers={servers}
                    onViewContainers={(project) => {
                        setContainerFilter(project);
                        onNavigate({ section: "containers" });
                    }}
                    onOpenStack={(id) => onNavigate({ section: "stacks", stackId: id, stackTab: "overview" })}
                />
            )}

            {section === "containers" && (
                <DockerContainers
                    serverId={serverId}
                    initialFilter={filter ?? containerFilter}
                    containerId={containerId}
                    onOpenContainer={(id) => onNavigate({ section: "containers", filter, containerId: id })}
                    onCloseContainer={() => onNavigate({ section: "containers", filter })}
                />
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
