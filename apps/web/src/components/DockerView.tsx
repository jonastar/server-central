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
    stack?: string;
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

export function DockerView({ serverId, section, volume, path, file, filter, stack, containerId, stackId, stackTab, servers, onNavigate }: {
    serverId: string;
    section: DockerSection;
    volume?: string;
    path?: string;
    file: string | null;
    /** Route-carried containers filter (deep links from other views). */
    filter?: string;
    /** Containers section: compose project the list is scoped to. */
    stack?: string;
    /** Containers section: the container whose detail view is open. */
    containerId?: string;
    /** Stacks section: the registered stack being viewed, if any. */
    stackId?: string;
    stackTab: ComposeStackTab;
    servers: ServerEntry[];
    onNavigate: (next: DockerNav) => void;
}) {
    if (section === "stacks" && stackId) {
        return (
            <ComposeStackView
                stackId={stackId}
                tab={stackTab}
                servers={servers}
                onNavigate={(next) => onNavigate({ section: "stacks", stackId, stackTab: next })}
                onBack={() => onNavigate({ section: "stacks" })}
                onOpenContainers={(project, id) => onNavigate({ section: "containers", stack: project, containerId: id })}
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
                        onClick={() => onNavigate({ section: s.id })}
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
                    onViewContainers={(project) => onNavigate({ section: "containers", stack: project })}
                    onOpenStack={(id) => onNavigate({ section: "stacks", stackId: id, stackTab: "overview" })}
                />
            )}

            {section === "containers" && (
                <DockerContainers
                    serverId={serverId}
                    hostIp={servers.find((s) => s.id === serverId)?.status.info?.primaryIp}
                    stack={stack}
                    initialFilter={filter}
                    containerId={containerId}
                    onOpenContainer={(id) => onNavigate({ section: "containers", filter, stack, containerId: id })}
                    onCloseContainer={() => onNavigate({ section: "containers", filter, stack })}
                    onClearStack={() => onNavigate({ section: "containers", filter, containerId })}
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
