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
}

export function FilesView({ serverId }: { serverId: string }) {
    const [path, setPath] = useState("/");
    const [entries, setEntries] = useState<DirEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [file, setFile] = useState<OpenFile | null>(null);
    const [saving, setSaving] = useState(false);

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
        setPath("/");
        setFile(null);
        setEntries(null);
    }, [serverId]);

    useEffect(() => {
        void load(path);
    }, [path, load]);

    async function openFile(filePath: string) {
        setError(null);
        try {
            const res = await api("readFile", { serverId, path: filePath });
            setFile({ path: filePath, content: res.content, original: res.content, truncated: res.truncated, binary: res.binary });
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    async function saveFile() {
        if (!file || file.binary || file.truncated) return;
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
        if (!name) return;
        try {
            await api("createDir", { serverId, path: joinPath(path, name) });
            void load(path);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    function newFile() {
        const name = prompt("New file name:");
        if (!name) return;
        setFile({ path: joinPath(path, name), content: "", original: "\0", truncated: false, binary: false });
    }

    async function rename(entry: DirEntry) {
        const name = prompt(`Rename "${entry.name}" to:`, entry.name);
        if (!name || name === entry.name) return;
        const from = joinPath(path, entry.name);
        const to = joinPath(path, name);
        try {
            await api("renamePath", { serverId, from, to });
            if (file?.path === from) setFile({ ...file, path: to });
            void load(path);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    async function remove(entry: DirEntry) {
        if (!confirm(`Delete "${entry.name}"?${entry.type === "dir" ? " (must be empty)" : ""}`)) return;
        const target = joinPath(path, entry.name);
        try {
            await api("deletePath", { serverId, path: target });
            if (file?.path === target) setFile(null);
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
                            {file.binary && <span className="badge badge-warn">binary</span>}
                            <button
                                className="btn btn-primary"
                                onClick={() => void saveFile()}
                                disabled={saving || file.binary || file.truncated || !dirty}
                            >
                                {saving ? "Saving…" : "Save"}
                            </button>
                            <button className="btn" onClick={() => !dirty || confirm("Discard unsaved changes?") ? setFile(null) : undefined}>
                                Close
                            </button>
                        </div>
                        {file.binary ? (
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
