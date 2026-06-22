import { useCallback, useEffect, useState } from "react";
import type { DirEntry, InstallProbeResult } from "@central/shared";
import { api } from "../api";
import { cx } from "../utils";

function joinPath(dir: string, name: string): string {
    return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function parentOf(p: string): string {
    const idx = p.lastIndexOf("/");
    return idx <= 0 ? "/" : p.slice(0, idx);
}

/**
 * Browse the agent's filesystem and select a directory. The directory currently
 * being browsed is the selection (reported via onChange); each candidate is probed
 * live for writable + exec-capable so unusable appliance paths are flagged before
 * install. Supports creating a new folder in place.
 */
export function DirectoryPicker({ serverId, value, onChange }: {
    serverId: string;
    /** Currently selected/browsed directory. */
    value: string;
    onChange: (path: string) => void;
}) {
    const [entries, setEntries] = useState<DirEntry[] | null>(null);
    const [probe, setProbe] = useState<InstallProbeResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async (dir: string) => {
        setError(null);
        setEntries(null);
        setProbe(null);
        try {
            const [list, p] = await Promise.all([
                api("listDir", { serverId, path: dir }),
                api("probeInstallPath", { serverId, path: dir }).catch(() => null),
            ]);
            setEntries(list.entries.filter((e) => e.type === "dir" || e.type === "symlink"));
            setProbe(p);
        } catch (err) {
            setEntries([]);
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [serverId]);

    useEffect(() => {
        void load(value);
    }, [value, load]);

    async function mkdir() {
        const name = prompt("New folder name:");
        if (!name) {
            return;
        }
        try {
            await api("createDir", { serverId, path: joinPath(value, name) });
            await load(value);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    const crumbs = value === "/" ? [""] : value.split("/");
    const usable = probe?.writable && probe?.execCapable;

    return (
        <div className="dir-picker">
            <div className="breadcrumbs" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2 }}>
                {crumbs.map((seg, i) => {
                    const target = i === 0 ? "/" : crumbs.slice(0, i + 1).join("/");
                    return (
                        <span key={target}>
                            {i > 0 && <span className="crumb-sep">/</span>}
                            <button className="crumb" onClick={() => onChange(target)}>{i === 0 ? "/" : seg}</button>
                        </span>
                    );
                })}
                <span style={{ flex: 1 }} />
                <button className="btn" onClick={() => void mkdir()}>New folder</button>
            </div>

            <div
                className="dir-picker-list"
                style={{ maxHeight: 200, overflow: "auto", border: "1px solid var(--border, #333)", borderRadius: 4, marginTop: 6 }}
            >
                <table className="data-table">
                    <tbody>
                        {value !== "/" && (
                            <tr className="row-clickable" onClick={() => onChange(parentOf(value))}>
                                <td className="file-name dir">..</td>
                            </tr>
                        )}
                        {entries === null && <tr><td className="dim">Loading…</td></tr>}
                        {entries?.map((entry) => (
                            <tr key={entry.name} className="row-clickable" onClick={() => onChange(joinPath(value, entry.name))}>
                                <td className={cx("file-name", entry.type)}>{entry.name}{entry.type === "symlink" && " →"}</td>
                            </tr>
                        ))}
                        {entries?.length === 0 && !error && <tr><td className="dim">No subfolders</td></tr>}
                    </tbody>
                </table>
            </div>

            <div style={{ marginTop: 6, fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
                <code style={{ flex: 1 }}>{value}</code>
                {probe && (
                    <span className={cx("badge", usable ? "badge-ok" : "badge-warn")}>
                        {usable
                            ? (probe.exists ? "writable + executable" : "will be created")
                            : !probe.writable ? "not writable" : "noexec mount"}
                    </span>
                )}
            </div>

            {error && <div className="error-banner" style={{ marginTop: 8 }}>{error}</div>}
        </div>
    );
}
