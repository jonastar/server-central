import { useCallback, useEffect, useState } from "react";
import type { DirEntry } from "@central/shared";
import { api } from "../api";
import { cx, fmtBytes, fmtDateTime } from "../utils";
import { CodeEditor } from "./CodeEditor";
import { ErrorBanner } from "./ui";

function joinPath(dir: string, name: string): string {
    return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function parentOf(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx <= 0 ? "/" : path.slice(0, idx);
}

interface OpenFile {
    path: string;
    content: string;
    original: string;
    truncated: boolean;
    binary: boolean;
    /** Set for images; `content` then holds base64 bytes for an inline preview. */
    mimeType?: string;
}

/** Patch to the URL-backed files state: change folder and/or open file. */
export interface FilesNav {
    path?: string;
    file?: string | null;
}

export function FilesView({ serverId, path, openFile: openFilePath, onNavigate }: {
    serverId: string;
    /** Current folder (from the URL). */
    path: string;
    /** Path of the open file (from the URL), or null. */
    openFile: string | null;
    onNavigate: (patch: FilesNav) => void;
}) {
    const [entries, setEntries] = useState<DirEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [file, setFile] = useState<OpenFile | null>(null);
    const [saving, setSaving] = useState(false);

    const setPath = useCallback((dir: string) => onNavigate({ path: dir, file: null }), [onNavigate]);

    const load = useCallback(async (dir: string) => {
        setError(null);
        try {
            const res = await api("listDir", { serverId, path: dir });
            setEntries(res.entries);
        } catch (err) {
            setEntries([]);
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [serverId]);

    useEffect(() => {
        setEntries(null);
        void load(path);
    }, [path, load]);

    // Sync the open editor buffer with the URL's file. Skip re-fetching when the
    // buffer already holds that file (e.g. a freshly-created unsaved draft).
    useEffect(() => {
        if (!openFilePath) { setFile(null); return; }
        if (file?.path === openFilePath) {
            return;
        }
        let cancelled = false;
        setError(null);
        api("readFile", { serverId, path: openFilePath })
            .then((res) => {
                if (cancelled) {
                    return;
                }
                setFile({ path: openFilePath, content: res.content, original: res.content, truncated: res.truncated, binary: res.binary, mimeType: res.mimeType });
            })
            .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [serverId, openFilePath]);

    function openFile(filePath: string) {
        onNavigate({ file: filePath });
    }

    async function saveFile() {
        if (!file || file.binary || file.truncated) {
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await api("writeFile", { serverId, path: file.path, content: file.content });
            setFile({ ...file, original: file.content });
            void load(path);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setSaving(false);
        }
    }

    async function mkdir() {
        const name = prompt("New folder name:");
        if (!name) {
            return;
        }
        try {
            await api("createDir", { serverId, path: joinPath(path, name) });
            void load(path);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    function newFile() {
        const name = prompt("New file name:");
        if (!name) {
            return;
        }
        const newPath = joinPath(path, name);
        // Seed the buffer before navigating so the sync effect treats it as an
        // already-open (unsaved) draft rather than fetching a non-existent file.
        setFile({ path: newPath, content: "", original: "\0", truncated: false, binary: false });
        onNavigate({ file: newPath });
    }

    async function rename(entry: DirEntry) {
        const name = prompt(`Rename "${entry.name}" to:`, entry.name);
        if (!name || name === entry.name) {
            return;
        }
        const from = joinPath(path, entry.name);
        const to = joinPath(path, name);
        try {
            await api("renamePath", { serverId, from, to });
            if (file?.path === from) { setFile({ ...file, path: to }); onNavigate({ file: to }); }
            void load(path);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    async function remove(entry: DirEntry) {
        if (!confirm(`Delete "${entry.name}"?${entry.type === "dir" ? " (must be empty)" : ""}`)) {
            return;
        }
        const target = joinPath(path, entry.name);
        try {
            await api("deletePath", { serverId, path: target });
            if (file?.path === target) {
                onNavigate({ file: null });
            }
            void load(path);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    const crumbs = path === "/" ? [""] : path.split("/");
    const dirty = file !== null && file.content !== file.original;

    return (
        <div className="view files-view">
            <header className="view-header">
                <div className="breadcrumbs">
                    {crumbs.map((seg, i) => {
                        const target = i === 0 ? "/" : crumbs.slice(0, i + 1).join("/");
                        return (
                            <span key={target}>
                                {i > 0 && <span className="crumb-sep">/</span>}
                                <button className="crumb" onClick={() => setPath(target)}>{i === 0 ? "" : seg}</button>
                            </span>
                        );
                    })}
                </div>
                <span style={{ flex: 1 }} />
                <button className="btn" onClick={newFile}>New file</button>
                <button className="btn" onClick={mkdir}>New folder</button>
                <button className="btn" onClick={() => void load(path)}>Refresh</button>
            </header>

            {error && <ErrorBanner>{error}</ErrorBanner>}

            <div className={cx("files-split", file && "with-editor")}>
                <div className="files-list">
                    <table className="data-table">
                        <thead>
                            <tr><th>Name</th><th>Size</th><th>Modified</th><th>Mode</th><th /></tr>
                        </thead>
                        <tbody>
                            {path !== "/" && (
                                <tr className="row-clickable" onClick={() => setPath(parentOf(path))}>
                                    <td className="file-name dir">..</td><td /><td /><td /><td />
                                </tr>
                            )}
                            {entries === null && <tr><td colSpan={5} className="dim">Loading…</td></tr>}
                            {entries?.map((entry) => (
                                <tr
                                    key={entry.name}
                                    className={cx("row-clickable", file?.path === joinPath(path, entry.name) && "row-active")}
                                    onClick={() => entry.type === "dir"
                                        ? setPath(joinPath(path, entry.name))
                                        : void openFile(joinPath(path, entry.name))}
                                >
                                    <td className={cx("file-name", entry.type)}>{entry.name}{entry.type === "symlink" && " →"}</td>
                                    <td className="dim">{entry.type === "file" ? fmtBytes(entry.sizeBytes) : ""}</td>
                                    <td className="dim">{fmtDateTime(entry.modifiedAt)}</td>
                                    <td className="dim mono">{entry.permissions}</td>
                                    <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                                        <button className="btn-icon" title="Rename" onClick={() => void rename(entry)}>✎</button>
                                        <button className="btn-icon" title="Delete" onClick={() => void remove(entry)}>🗑</button>
                                    </td>
                                </tr>
                            ))}
                            {entries?.length === 0 && !error && <tr><td colSpan={5} className="dim">Empty directory</td></tr>}
                        </tbody>
                    </table>
                </div>

                {file && (
                    <div className="editor-pane">
                        <div className="editor-toolbar">
                            <span className="editor-path mono" title={file.path}>{file.path}{dirty ? " •" : ""}</span>
                            <span style={{ flex: 1 }} />
                            {file.truncated && <span className="badge badge-warn">truncated — read only</span>}
                            {file.mimeType && <span className="badge badge-ok">image</span>}
                            {file.binary && !file.mimeType && <span className="badge badge-warn">binary</span>}
                            {!file.mimeType && (
                                <button
                                    className="btn btn-primary"
                                    onClick={() => void saveFile()}
                                    disabled={saving || file.binary || file.truncated || !dirty}
                                >
                                    {saving ? "Saving…" : "Save"}
                                </button>
                            )}
                            <button className="btn" onClick={() => !dirty || confirm("Discard unsaved changes?") ? onNavigate({ file: null }) : undefined}>
                                Close
                            </button>
                        </div>
                        {file.mimeType ? (
                            <div className="image-preview">
                                <img src={`data:${file.mimeType};base64,${file.content}`} alt={file.path} />
                            </div>
                        ) : file.binary ? (
                            <div className="editor-loading">Binary file ({fmtBytes(file.content.length)}) — not editable.</div>
                        ) : (
                            <div className="editor-host">
                                <CodeEditor
                                    path={file.path}
                                    value={file.content}
                                    onChange={(content) => setFile((f) => (f ? { ...f, content } : f))}
                                    onSave={() => void saveFile()}
                                />
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
