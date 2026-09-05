import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_UPLOAD_BYTES, type DirEntry } from "@central/shared";
import { api } from "../api";
import { base64ToBytes, bytesToBase64, cx, fmtBytes, fmtDateTime } from "../utils";
import { CodeEditor } from "./CodeEditor";
import { ErrorBanner } from "./ui";
import styles from "./FilesView.module.css";
import shared from "../styles/shared.module.css";

function joinPath(dir: string, name: string): string {
    return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

function parentOf(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx <= 0 ? "/" : path.slice(0, idx);
}

/** Only "dir" and "symlink" get a modifier class; plain files use the base style. */
const fileTypeClass: Partial<Record<DirEntry["type"], string>> = {
    dir: shared.dir,
    symlink: shared.symlink,
};

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
    const [uploading, setUploading] = useState(false);
    const [busy, setBusy] = useState(false);
    /** Names (relative to `path`) of the rows ticked for a toolbar action. */
    const [selected, setSelected] = useState<Set<string>>(new Set());
    /** Index of the last ticked row, so shift-click can extend a range. */
    const lastPickedRef = useRef<number | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const setPath = useCallback((dir: string) => onNavigate({ path: dir, file: null }), [onNavigate]);

    const load = useCallback(async (dir: string) => {
        setError(null);
        try {
            const res = await api("files", "listDir", { serverId, path: dir });
            setEntries(res.entries);
        } catch (err) {
            setEntries([]);
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [serverId]);

    useEffect(() => {
        setEntries(null);
        setSelected(new Set());
        lastPickedRef.current = null;
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
        api("files", "read", { serverId, path: openFilePath })
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

    function downloadFile() {
        if (!file) {
            return;
        }
        const blob = file.binary
            ? new Blob([base64ToBytes(file.content) as BlobPart], { type: file.mimeType || "application/octet-stream" })
            : new Blob([file.content], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.path.slice(file.path.lastIndexOf("/") + 1) || "download";
        a.click();
        URL.revokeObjectURL(url);
    }

    async function saveFile() {
        if (!file || file.binary || file.truncated) {
            return;
        }
        setSaving(true);
        setError(null);
        try {
            await api("files", "write", { serverId, path: file.path, content: file.content });
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
            await api("files", "createDir", { serverId, path: joinPath(path, name) });
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

    async function uploadFiles(files: FileList) {
        setUploading(true);
        setError(null);
        // One bad file (too large, rejected, ...) shouldn't stop the rest of the batch —
        // collect failures and keep going, then report them all together.
        const failures: string[] = [];
        for (const f of Array.from(files)) {
            if (f.size > MAX_UPLOAD_BYTES) {
                failures.push(`${f.name}: too large (${fmtBytes(f.size)}, max ${fmtBytes(MAX_UPLOAD_BYTES)})`);
                continue;
            }
            try {
                const bytes = new Uint8Array(await f.arrayBuffer());
                await api("files", "upload", { serverId, path: joinPath(path, f.name), contentBase64: bytesToBase64(bytes) });
            } catch (err) {
                failures.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        void load(path);
        setUploading(false);
        if (failures.length > 0) {
            setError(failures.join("; "));
        }
    }

    function clearSelection() {
        setSelected(new Set());
        lastPickedRef.current = null;
    }

    /** Tick/untick a row; shift-click extends the range from the last picked row. */
    function toggleSelected(index: number, shift: boolean) {
        if (!entries) {
            return;
        }
        const next = new Set(selected);
        const anchor = lastPickedRef.current;
        if (shift && anchor !== null) {
            const [lo, hi] = anchor <= index ? [anchor, index] : [index, anchor];
            for (let i = lo; i <= hi; i++) {
                next.add(entries[i].name);
            }
        } else if (next.has(entries[index].name)) {
            next.delete(entries[index].name);
        } else {
            next.add(entries[index].name);
        }
        lastPickedRef.current = index;
        setSelected(next);
    }

    function toggleSelectAll() {
        if (!entries) {
            return;
        }
        setSelected(selected.size === entries.length ? new Set() : new Set(entries.map((e) => e.name)));
        lastPickedRef.current = null;
    }

    /** Selected rows in listing order; stale names (deleted, moved) drop out. */
    const selectedEntries = entries?.filter((e) => selected.has(e.name)) ?? [];

    /** Runs `op` per selected entry, collecting failures so one bad entry doesn't stop the batch. */
    async function runOnSelection(op: (entry: DirEntry) => Promise<void>) {
        setBusy(true);
        setError(null);
        const failures: string[] = [];
        for (const entry of selectedEntries) {
            try {
                await op(entry);
            } catch (err) {
                failures.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        clearSelection();
        void load(path);
        setBusy(false);
        if (failures.length > 0) {
            setError(failures.join("; "));
        }
    }

    async function renameSelected() {
        const entry = selectedEntries[0];
        if (selectedEntries.length !== 1 || !entry) {
            return;
        }
        const name = prompt(`Rename "${entry.name}" to:`, entry.name);
        if (!name || name === entry.name) {
            return;
        }
        const from = joinPath(path, entry.name);
        const to = joinPath(path, name);
        setBusy(true);
        setError(null);
        try {
            await api("files", "rename", { serverId, from, to });
            if (file?.path === from) { setFile({ ...file, path: to }); onNavigate({ file: to }); }
            clearSelection();
            void load(path);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function moveSelected() {
        if (selectedEntries.length === 0) {
            return;
        }
        const dest = prompt(
            selectedEntries.length === 1 ? `Move "${selectedEntries[0].name}" to directory:` : `Move ${selectedEntries.length} items to directory:`,
            path,
        );
        if (!dest || dest === path) {
            return;
        }
        await runOnSelection(async (entry) => {
            const from = joinPath(path, entry.name);
            await api("files", "rename", { serverId, from, to: joinPath(dest, entry.name) });
            if (file?.path === from) { onNavigate({ file: null }); }
        });
    }

    async function removeSelected() {
        if (selectedEntries.length === 0) {
            return;
        }
        const hasDir = selectedEntries.some((e) => e.type === "dir");
        const what = selectedEntries.length === 1 ? `"${selectedEntries[0].name}"` : `${selectedEntries.length} items`;
        if (!confirm(`Delete ${what}?${hasDir ? " (directories must be empty)" : ""}`)) {
            return;
        }
        await runOnSelection(async (entry) => {
            const target = joinPath(path, entry.name);
            await api("files", "delete", { serverId, path: target });
            if (file?.path === target) { onNavigate({ file: null }); }
        });
    }

    const crumbs = path === "/" ? [""] : path.split("/");
    const dirty = file !== null && file.content !== file.original;

    return (
        <div className={cx(shared.view, styles["files-view"])}>
            <header className={cx(shared["view-header"], styles["files-toolbar"])}>
                <div className={shared.breadcrumbs}>
                    {crumbs.map((seg, i) => {
                        const target = i === 0 ? "/" : crumbs.slice(0, i + 1).join("/");
                        return (
                            <span key={target}>
                                {i > 0 && <span className={shared["crumb-sep"]}>/</span>}
                                <button className={shared.crumb} onClick={() => setPath(target)}>{i === 0 ? "" : seg}</button>
                            </span>
                        );
                    })}
                </div>
                <span style={{ flex: 1 }} />
                {selected.size > 0 && <span className={styles["selection-count"]}>{selected.size} selected</span>}
                <button
                    className={shared.btn}
                    onClick={() => void renameSelected()}
                    disabled={busy || selected.size !== 1}
                    title={selected.size > 1 ? "Select a single item to rename" : "Rename"}
                >
                    Rename
                </button>
                <button className={shared.btn} onClick={() => void moveSelected()} disabled={busy || selected.size === 0}>Move</button>
                <button
                    className={cx(shared.btn, selected.size > 0 && shared["btn-danger"])}
                    onClick={() => void removeSelected()}
                    disabled={busy || selected.size === 0}
                >
                    Delete
                </button>
                <span className={styles["toolbar-sep"]} />
                <button className={shared.btn} onClick={newFile}>New file</button>
                <button className={shared.btn} onClick={mkdir}>New folder</button>
                <button className={shared.btn} onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                    {uploading ? "Uploading…" : "Upload"}
                </button>
                <button className={shared.btn} onClick={() => void load(path)}>Refresh</button>
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    style={{ display: "none" }}
                    onChange={(e) => {
                        const files = e.target.files;
                        if (files && files.length > 0) { void uploadFiles(files); }
                        e.target.value = "";
                    }}
                />
            </header>

            {error && <ErrorBanner>{error}</ErrorBanner>}

            <div className={cx(styles["files-split"], file && styles["with-editor"])}>
                <div className={styles["files-list"]}>
                    <table className={shared["data-table"]}>
                        <thead>
                            <tr>
                                <th className={styles["col-select"]}>
                                    <input
                                        type="checkbox"
                                        aria-label="Select all"
                                        checked={entries !== null && entries.length > 0 && selected.size === entries.length}
                                        ref={(el) => { if (el) el.indeterminate = selected.size > 0 && selected.size < (entries?.length ?? 0); }}
                                        disabled={!entries || entries.length === 0}
                                        onChange={toggleSelectAll}
                                    />
                                </th>
                                <th>Name</th><th>Size</th><th>Modified</th><th>Mode</th>
                            </tr>
                        </thead>
                        <tbody>
                            {path !== "/" && (
                                <tr className={shared["row-clickable"]} onClick={() => setPath(parentOf(path))}>
                                    <td className={styles["col-select"]} /><td className={cx(shared["file-name"], shared.dir)}>..</td><td /><td /><td />
                                </tr>
                            )}
                            {entries === null && <tr><td colSpan={5} className={shared.dim}>Loading…</td></tr>}
                            {entries?.map((entry, i) => (
                                <tr
                                    key={entry.name}
                                    className={cx(
                                        shared["row-clickable"],
                                        file?.path === joinPath(path, entry.name) && shared["row-active"],
                                        selected.has(entry.name) && styles["row-selected"],
                                    )}
                                    onClick={() => entry.type === "dir"
                                        ? setPath(joinPath(path, entry.name))
                                        : void openFile(joinPath(path, entry.name))}
                                >
                                    {/* The tick column drives the toolbar actions; it must not
                                        navigate, so clicks stop before the row handler. */}
                                    <td
                                        className={styles["col-select"]}
                                        onClick={(e) => { e.stopPropagation(); toggleSelected(i, e.shiftKey); }}
                                    >
                                        <input
                                            type="checkbox"
                                            aria-label={`Select ${entry.name}`}
                                            checked={selected.has(entry.name)}
                                            onChange={() => { /* handled on the cell so the whole box is a target */ }}
                                        />
                                    </td>
                                    <td className={cx(shared["file-name"], fileTypeClass[entry.type])}>{entry.name}{entry.type === "symlink" && " →"}</td>
                                    <td className={shared.dim}>{entry.type === "file" ? fmtBytes(entry.sizeBytes) : ""}</td>
                                    <td className={shared.dim}>{fmtDateTime(entry.modifiedAt)}</td>
                                    <td className={cx(shared.dim, shared.mono)}>{entry.permissions}</td>
                                </tr>
                            ))}
                            {entries?.length === 0 && !error && <tr><td colSpan={5} className={shared.dim}>Empty directory</td></tr>}
                        </tbody>
                    </table>
                </div>

                {file && (
                    <div className={styles["editor-pane"]}>
                        <div className={styles["editor-toolbar"]}>
                            <span className={cx(styles["editor-path"], shared.mono)} title={file.path}>{file.path}{dirty ? " •" : ""}</span>
                            <span style={{ flex: 1 }} />
                            {file.truncated && <span className={cx(shared.badge, shared["badge-warn"])}>truncated — read only</span>}
                            {file.mimeType && <span className={cx(shared.badge, shared["badge-ok"])}>image</span>}
                            {file.binary && !file.mimeType && <span className={cx(shared.badge, shared["badge-warn"])}>binary</span>}
                            <button
                                className={shared.btn}
                                onClick={downloadFile}
                                disabled={file.truncated}
                                title={file.truncated ? "Can't download — only a truncated preview was loaded" : "Download"}
                            >
                                Download
                            </button>
                            {!file.mimeType && (
                                <button
                                    className={cx(shared.btn, shared["btn-primary"])}
                                    onClick={() => void saveFile()}
                                    disabled={saving || file.binary || file.truncated || !dirty}
                                >
                                    {saving ? "Saving…" : "Save"}
                                </button>
                            )}
                            <button className={shared.btn} onClick={() => !dirty || confirm("Discard unsaved changes?") ? onNavigate({ file: null }) : undefined}>
                                Close
                            </button>
                        </div>
                        {file.mimeType ? (
                            <div className={styles["image-preview"]}>
                                <img src={`data:${file.mimeType};base64,${file.content}`} alt={file.path} />
                            </div>
                        ) : file.binary ? (
                            <div className={shared["editor-loading"]}>Binary file ({fmtBytes(file.content.length)}) — not editable.</div>
                        ) : (
                            <div className={styles["editor-host"]}>
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
