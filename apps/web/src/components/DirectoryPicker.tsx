import { useCallback, useEffect, useRef, useState } from "react";
import type { DirEntry, InstallProbeResult } from "@central/shared";
import { api } from "../api";
import { cx } from "../utils";
import shared from "../styles/shared.module.css";
import uiStyles from "./ui.module.css";

function joinPath(dir: string, name: string): string {
    return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/** Every path from `/` down to (and including) `path`, e.g. "/a/b" ->
 *  ["/", "/a", "/a/b"] — used to pre-expand the tree down to the current value. */
function ancestorChain(path: string): string[] {
    if (path === "/") {
        return ["/"];
    }
    const segments = path.split("/").filter(Boolean);
    const chain = ["/"];
    let cur = "";
    for (const seg of segments) {
        cur += `/${seg}`;
        chain.push(cur);
    }
    return chain;
}

/** Only "dir" and "symlink" get a modifier class; plain files use the base style. */
export const fileTypeClass: Partial<Record<DirEntry["type"], string>> = {
    dir: shared.dir,
    symlink: shared.symlink,
};

/**
 * Browse the agent's filesystem and select a directory (or, with `selectFiles`,
 * a file — for bind-mounting a single existing file rather than a directory),
 * as an expandable tree — expanding a branch (chevron) is separate from
 * selecting it (clicking the name), so the selected entry stays visible and
 * highlighted no matter where else you go exploring, instead of "selected" and
 * "currently browsing" being the same disconnected notion. The selection is
 * probed live for writable + exec-capable so unusable appliance paths are
 * flagged before install. Supports creating a new folder inside the current
 * selection.
 */
export function DirectoryPicker({ serverId, value, onChange, selectFiles }: {
    serverId: string;
    /** Currently selected directory (or file, with `selectFiles`). */
    value: string;
    onChange: (path: string) => void;
    /** Also list and allow selecting files, not just directories — off by
     *  default, since most callers (install/base/import dir pickers) only ever
     *  want a directory. */
    selectFiles?: boolean;
}) {
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [children, setChildren] = useState<Map<string, DirEntry[] | "error">>(new Map());
    const [probe, setProbe] = useState<InstallProbeResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Paths already fetched or in flight — a plain ref (not state) so looping
    // over an ancestor chain synchronously dedupes without a setState-inside-
    // updater side effect, which could double-fire under React 18 and would
    // otherwise need a placeholder value that renders as a false "error" flash.
    const requested = useRef<Set<string>>(new Set());

    // A different host invalidates every cached path.
    useEffect(() => {
        requested.current = new Set();
        setChildren(new Map());
        setExpanded(new Set());
    }, [serverId]);

    // Unfiltered — keeps file entries around even when `selectFiles` is off, so
    // "does this dir have anything in it" and "how many files" can still be
    // answered for dirs that hold files but no subdirectories to browse into.
    const ensureLoaded = useCallback((path: string) => {
        if (requested.current.has(path)) {
            return;
        }
        requested.current.add(path);
        void (async () => {
            try {
                const list = await api("files", "listDir", { serverId, path });
                setChildren((m) => new Map(m).set(path, list.entries));
            } catch {
                setChildren((m) => new Map(m).set(path, "error"));
            }
        })();
    }, [serverId]);

    useEffect(() => {
        const chain = ancestorChain(value);
        setExpanded((prev) => new Set([...prev, ...chain]));
        for (const path of chain) {
            ensureLoaded(path);
        }
        setError(null);
        api("servers", "probeInstallPath", { serverId, path: value })
            .then(setProbe)
            .catch(() => setProbe(null));
    }, [value, serverId, ensureLoaded]);

    function toggleExpand(path: string) {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            return next;
        });
        ensureLoaded(path);
    }

    function select(path: string) {
        onChange(path);
    }

    async function mkdir() {
        const name = prompt("New folder name:");
        if (!name) {
            return;
        }
        try {
            await api("files", "createDir", { serverId, path: joinPath(value, name) });
            requested.current.delete(value);
            setChildren((prev) => {
                const next = new Map(prev);
                next.delete(value);
                return next;
            });
            ensureLoaded(value);
            setExpanded((prev) => new Set(prev).add(value));
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    function renderNode(path: string, depth: number, type: DirEntry["type"] = "dir"): React.ReactNode {
        const expandable = type === "dir" || type === "symlink";
        const isExpanded = expandable && expanded.has(path);
        const kids = expandable ? children.get(path) : undefined;
        const rawKids = Array.isArray(kids) ? kids : undefined;
        // What actually gets its own row below this one — subdirectories always,
        // files only when `selectFiles` is on. A dir full of plain files has
        // `rawKids.length > 0` but `browsableKids.length === 0`: nothing to
        // descend into, but not "empty" either.
        const browsableKids = rawKids?.filter((e) => e.type === "dir" || e.type === "symlink" || (selectFiles && e.type === "file"));
        const fileCount = rawKids?.filter((e) => e.type === "file").length ?? 0;
        const isSelected = path === value;
        const label = path === "/" ? "/" : (path.split("/").pop() ?? path);
        const hasChildren = expandable && (browsableKids ? browsableKids.length > 0 : kids === undefined);

        return (
            <div key={path}>
                <div
                    style={{
                        display: "flex", alignItems: "center", gap: 4, paddingLeft: 6 + depth * 16, borderRadius: 4,
                        background: isSelected ? "var(--accent-soft)" : undefined,
                    }}
                >
                    <span
                        className={cx(shared["row-expander"], isExpanded && shared.open)}
                        style={{ visibility: expandable && hasChildren ? "visible" : "hidden", cursor: "pointer", padding: 4 }}
                        onClick={() => expandable && toggleExpand(path)}
                    >
                        ▸
                    </span>
                    <span
                        className={cx(shared["file-name"], fileTypeClass[type], shared["row-clickable"])}
                        style={{ flex: 1, padding: "3px 4px" }}
                        onClick={() => select(path)}
                    >
                        {label}
                    </span>
                    {!selectFiles && fileCount > 0 && (
                        <span className={shared.dim} style={{ fontSize: 11 }}>{fileCount} file{fileCount === 1 ? "" : "s"}</span>
                    )}
                </div>
                {isExpanded && kids === "error" && (
                    <div className={shared.dim} style={{ paddingLeft: 26 + depth * 16, fontSize: 12 }}>Can't read this directory</div>
                )}
                {isExpanded && rawKids && rawKids.length === 0 && (
                    <div className={shared.dim} style={{ paddingLeft: 26 + depth * 16, fontSize: 12, fontStyle: "italic" }}>(empty directory)</div>
                )}
                {isExpanded && rawKids && rawKids.length > 0 && browsableKids?.length === 0 && (
                    <div className={shared.dim} style={{ paddingLeft: 26 + depth * 16, fontSize: 12, fontStyle: "italic" }}>
                        {fileCount} file{fileCount === 1 ? "" : "s"}, no subfolders
                    </div>
                )}
                {isExpanded && browsableKids?.map((entry) => renderNode(joinPath(path, entry.name), depth + 1, entry.type))}
            </div>
        );
    }

    const usable = probe?.writable && probe?.execCapable;

    return (
        <div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
                <button className={shared.btn} onClick={() => void mkdir()}>New folder in selection</button>
            </div>

            <div style={{ maxHeight: 260, overflow: "auto", border: "1px solid var(--border, #333)", borderRadius: 4 }}>
                {renderNode("/", 0)}
            </div>

            <div style={{ marginTop: 6, fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
                <code style={{ flex: 1 }}>{value}</code>
                {probe && (
                    <span className={cx(shared.badge, usable ? shared["badge-ok"] : shared["badge-warn"])}>
                        {usable
                            ? (probe.exists ? "writable + executable" : "will be created")
                            : !probe.writable ? "not writable" : "noexec mount"}
                    </span>
                )}
            </div>

            {error && <div className={uiStyles["error-banner"]} style={{ marginTop: 8 }}>{error}</div>}
        </div>
    );
}
