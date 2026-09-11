import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UPLOAD_REQUEST_BYTES, type DirEntry, type MountInfo } from "@central/shared";
import { api } from "../api";
import { base64ToBytes, cx, fmtBytes, fmtDateTime, randomId } from "../utils";
import { byMountpoint, invalidateHostMounts, mountUsage, useHostMounts } from "../hooks/useHostMounts";
import { CodeEditor } from "./CodeEditor";
import { MountPicker } from "./MountPicker";
import { MoveFilesModal, type MovedPath } from "./MoveFilesModal";
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

/** Mark the run of the name that matched, so a filtered list still reads as
 *  names rather than a column of near-identical strings. */
function highlight(name: string, query: string): React.ReactNode {
    const at = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1;
    if (at < 0) {
        return name;
    }
    return (
        <>
            {name.slice(0, at)}
            <mark className={styles.match}>{name.slice(at, at + query.length)}</mark>
            {name.slice(at + query.length)}
        </>
    );
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
    /** Which file is going up and how far it's got — the transfer is streamed, so
     *  unlike the old read-then-send it can actually be reported as it happens. */
    const [uploadProgress, setUploadProgress] = useState<{ name: string; sent: number; total: number; index: number; count: number } | null>(null);
    const [busy, setBusy] = useState(false);
    /** Names (relative to `path`) of the rows ticked for a toolbar action. */
    const [selected, setSelected] = useState<Set<string>>(new Set());
    /** Index of the last ticked row, so shift-click can extend a range. */
    const lastPickedRef = useRef<number | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    /** Narrows the listing to names containing this, matched case-insensitively.
     *  Client-side over the directory that's already loaded — "quick" means it
     *  answers as you type, which a round trip per keystroke would not. */
    const [query, setQuery] = useState("");
    const searchRef = useRef<HTMLInputElement>(null);
    /** Rows the open destination picker is moving — a snapshot, not a live read
     *  of the selection, because a partial failure clears the selection while
     *  the dialog is still reporting which items didn't make it. */
    const [moving, setMoving] = useState<DirEntry[] | null>(null);
    const hostMounts = useHostMounts(serverId);
    const mountsByPath = useMemo(() => byMountpoint(hostMounts), [hostMounts]);

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
        setQuery("");
        lastPickedRef.current = null;
        void load(path);
    }, [path, load]);

    // A filter change renumbers the rows, so the shift-click anchor no longer
    // points at the row it was set on.
    useEffect(() => { lastPickedRef.current = null; }, [query]);

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
        const list = Array.from(files);
        for (const [index, f] of list.entries()) {
            // No size check: there is no size limit. A file goes up as however
            // many requests it takes, and nothing on the way holds more than one
            // slice, so what fits is a question about the host's disk.
            setUploadProgress({ name: f.name, sent: 0, total: f.size, index, count: list.length });
            try {
                // Not crypto.randomUUID: it doesn't exist over plain HTTP at a
                // LAN address, which is how this panel is often reached.
                const uploadId = randomId();
                const target = joinPath(path, f.name);
                // `slice` hands back a Blob that still refers to the file on
                // disk — the browser streams it when the request is sent, so
                // this tab never reads the file, whatever its size. One request
                // at a time, each saying where its slice belongs.
                for (let offset = 0; ; offset += UPLOAD_REQUEST_BYTES) {
                    const end = Math.min(offset + UPLOAD_REQUEST_BYTES, f.size);
                    const final = end >= f.size;
                    const sliceStart = offset;
                    await api("files", "upload", {
                        serverId, path: target, uploadId, offset, final, content: f.slice(offset, end),
                    }, {
                        // A request reports progress through its own body; the
                        // file's progress is where this slice starts plus how
                        // far into it that has got.
                        onProgress: (sent, total) => setUploadProgress({
                            name: f.name,
                            sent: Math.min(f.size, sliceStart + Math.round((sent / Math.max(1, total)) * (end - sliceStart))),
                            total: f.size,
                            index,
                            count: list.length,
                        }),
                    });
                    if (final) {
                        break;
                    }
                }
            } catch (err) {
                failures.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        setUploadProgress(null);
        void load(path);
        setUploading(false);
        if (failures.length > 0) {
            setError(failures.join("; "));
        }
    }

    /** The rows actually on screen. Everything about selection is defined over
     *  this rather than over `entries`: a row hidden by the filter can't be
     *  ticked, counted, or deleted by a toolbar button aimed at what's visible. */
    const visible = query
        ? (entries ?? []).filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
        : entries ?? [];

    function clearSelection() {
        setSelected(new Set());
        lastPickedRef.current = null;
    }

    /** Tick/untick a row; shift-click extends the range from the last picked row.
     *  `index` is into the visible rows, so a range drawn through a filtered list
     *  covers what was on screen between the two clicks and nothing else. */
    function toggleSelected(index: number, shift: boolean) {
        const entry = visible[index];
        if (!entry) {
            return;
        }
        const next = new Set(selected);
        const anchor = lastPickedRef.current;
        if (shift && anchor !== null && anchor < visible.length) {
            const [lo, hi] = anchor <= index ? [anchor, index] : [index, anchor];
            for (let i = lo; i <= hi; i++) {
                next.add(visible[i].name);
            }
        } else if (next.has(entry.name)) {
            next.delete(entry.name);
        } else {
            next.add(entry.name);
        }
        lastPickedRef.current = index;
        setSelected(next);
    }

    function toggleSelectAll() {
        if (visible.length === 0) {
            return;
        }
        const allTicked = visible.every((e) => selected.has(e.name));
        const next = new Set(selected);
        for (const entry of visible) {
            if (allTicked) {
                next.delete(entry.name);
            } else {
                next.add(entry.name);
            }
        }
        setSelected(next);
        lastPickedRef.current = null;
    }

    /** Selected rows in listing order; names hidden by the filter and stale ones
     *  (deleted, moved) both drop out — a toolbar action only ever touches rows
     *  the operator can see it about to touch. */
    const selectedEntries = visible.filter((e) => selected.has(e.name));

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

    /** The destination dialog did the moving; this is the aftermath — an open
     *  editor whose file is no longer at that path has to let go of it. */
    function onMoved(moved: MovedPath[]) {
        if (moved.length === 0) {
            return;
        }
        if (file && moved.some((m) => m.from === file.path)) {
            onNavigate({ file: null });
        }
        clearSelection();
        void load(path);
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

    /** What's left on a row that is itself a mounted filesystem. A directory has
     *  no size to show, so the column is free for it — which is what makes a
     *  folder full of disks (`/mnt`) readable as one. */
    function mountSize(mount: MountInfo) {
        if (mount.sizeBytes <= 0) {
            return "";
        }
        const usage = mountUsage(mount);
        return (
            <span className={styles["mount-free"]} title={`${mount.device} — ${usage.free} free of ${usage.total}`}>
                <span className={styles["mount-meter"]}>
                    <span
                        className={cx(styles["mount-meter-fill"], usage.used > 0.9 && styles["mount-meter-full"])}
                        style={{ width: `${Math.round(usage.used * 100)}%` }}
                    />
                </span>
                {usage.free} free
            </span>
        );
    }

    return (
        <div className={cx(shared.view, styles["files-view"])}>
            <header className={cx(shared["view-header"], styles["files-toolbar"])}>
                <MountPicker serverId={serverId} currentPath={path} onPick={setPath} compact />
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
                <div className={styles["files-search"]}>
                    <input
                        ref={searchRef}
                        className={cx(shared["filter-input"], styles["search-input"])}
                        placeholder="Filter this folder…"
                        value={query}
                        spellCheck={false}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") {
                                setQuery("");
                                e.currentTarget.blur();
                            }
                        }}
                    />
                    {query && (
                        <button
                            type="button"
                            className={styles["search-clear"]}
                            aria-label="Clear filter"
                            onClick={() => { setQuery(""); searchRef.current?.focus(); }}
                        >
                            ✕
                        </button>
                    )}
                </div>
                {query && entries && (
                    <span className={styles["selection-count"]}>{visible.length} of {entries.length}</span>
                )}
                <span style={{ flex: 1 }} />
                {selectedEntries.length > 0 && <span className={styles["selection-count"]}>{selectedEntries.length} selected</span>}
                <button
                    className={shared.btn}
                    onClick={() => void renameSelected()}
                    disabled={busy || selected.size !== 1}
                    title={selected.size > 1 ? "Select a single item to rename" : "Rename"}
                >
                    Rename
                </button>
                <button className={shared.btn} onClick={() => setMoving(selectedEntries)} disabled={busy || selected.size === 0}>Move…</button>
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
                    {uploadProgress
                        ? `Uploading ${uploadProgress.count > 1 ? `${uploadProgress.index + 1}/${uploadProgress.count} ` : ""}— ${Math.floor((uploadProgress.sent / Math.max(1, uploadProgress.total)) * 100)}%`
                        : uploading ? "Uploading…" : "Upload"}
                </button>
                <button
                    className={shared.btn}
                    onClick={() => { invalidateHostMounts(serverId); void load(path); }}
                >
                    Refresh
                </button>
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
                                        checked={visible.length > 0 && selectedEntries.length === visible.length}
                                        ref={(el) => { if (el) el.indeterminate = selectedEntries.length > 0 && selectedEntries.length < visible.length; }}
                                        disabled={visible.length === 0}
                                        onChange={toggleSelectAll}
                                    />
                                </th>
                                <th>Name</th><th>Size</th><th>Modified</th><th>Mode</th>
                            </tr>
                        </thead>
                        <tbody>
                            {path !== "/" && !query && (
                                <tr className={shared["row-clickable"]} onClick={() => setPath(parentOf(path))}>
                                    <td className={styles["col-select"]} /><td className={cx(shared["file-name"], shared.dir)}>..</td><td /><td /><td />
                                </tr>
                            )}
                            {entries === null && <tr><td colSpan={5} className={shared.dim}>Loading…</td></tr>}
                            {visible.map((entry, i) => {
                                const mount = entry.type === "dir" ? mountsByPath.get(joinPath(path, entry.name)) : undefined;
                                return (
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
                                    <td className={cx(shared["file-name"], fileTypeClass[entry.type])}>
                                        {highlight(entry.name, query)}{entry.type === "symlink" && " →"}
                                        {mount && (
                                            <span className={cx(shared.badge, shared["badge-muted"], styles["mount-badge"])}>{mount.fstype}</span>
                                        )}
                                    </td>
                                    <td className={shared.dim}>{entry.type === "file" ? fmtBytes(entry.sizeBytes) : mount && mountSize(mount)}</td>
                                    <td className={shared.dim}>{fmtDateTime(entry.modifiedAt)}</td>
                                    <td className={cx(shared.dim, shared.mono)}>{entry.permissions}</td>
                                </tr>
                                );
                            })}
                            {entries !== null && visible.length === 0 && !error && (
                                <tr>
                                    <td colSpan={5} className={shared.dim}>
                                        {query ? `Nothing here matches "${query}"` : "Empty directory"}
                                    </td>
                                </tr>
                            )}
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

            {moving && (
                <MoveFilesModal
                    serverId={serverId}
                    fromDir={path}
                    entries={moving}
                    onMoved={onMoved}
                    onClose={() => setMoving(null)}
                />
            )}
        </div>
    );
}
