import { useEffect, useState } from "react";
import { api } from "../../api";
import { EmptyState, ErrorBanner } from "../ui";
import { FilesView } from "../FilesView";

/**
 * Browses a Docker volume's contents by resolving its mountpoint via
 * `dockerVolumeInspect` and reusing the host FilesView rooted there. The
 * in-volume folder/file are carried on the route (path/file).
 */
export function VolumeBrowser({ serverId, volume, path, file, onNavigate, onBack }: {
    serverId: string;
    volume: string;
    path?: string;
    file: string | null;
    onNavigate: (patch: { path?: string; file?: string }) => void;
    onBack: () => void;
}) {
    const [mountpoint, setMountpoint] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        setMountpoint(null);
        api("dockerVolumeInspect", { serverId, name: volume })
            .then((d) => alive && setMountpoint(d.mountpoint))
            .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)));
        return () => { alive = false; };
    }, [serverId, volume]);

    return (
        <section className="panel">
            <div className="panel-head">
                <button className="btn btn-sm" onClick={onBack}>← Volumes</button>
                <h3 style={{ margin: 0 }}>{volume}</h3>
            </div>

            {error && <ErrorBanner>{error}</ErrorBanner>}
            {!mountpoint && !error && <EmptyState>Loading…</EmptyState>}

            {mountpoint && (
                <FilesView
                    serverId={serverId}
                    path={path ?? mountpoint}
                    openFile={file}
                    onNavigate={(patch) => onNavigate({
                        path: patch.path ?? path ?? mountpoint,
                        file: "file" in patch ? patch.file ?? undefined : file ?? undefined,
                    })}
                />
            )}
        </section>
    );
}
