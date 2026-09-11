import { useEffect, useState } from "react";
import type { DirEntry } from "@central/shared";
import { api } from "../api";
import { cx } from "../utils";
import { mountForPath, useHostMounts } from "../hooks/useHostMounts";
import { DirectoryPicker } from "./DirectoryPicker";
import { ErrorBanner, Modal } from "./ui";
import shared from "../styles/shared.module.css";
import styles from "./MoveFilesModal.module.css";

function joinPath(dir: string, name: string): string {
    return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

export interface MovedPath { from: string; to: string }

/** Why the destination can't be used, or null when it can. Checked here rather
 *  than left to the host, because every one of these fails with an errno the
 *  browser would have to translate back into the mistake that caused it — and
 *  the last one doesn't fail at all, it silently eats a file. */
function destProblem(dest: string, fromDir: string, entries: DirEntry[]): string | null {
    if (!dest.startsWith("/")) {
        return "Enter an absolute path, starting with /";
    }
    if (dest === fromDir) {
        return "That's the folder they're already in — pick another one.";
    }
    for (const entry of entries) {
        if (entry.type !== "dir") {
            continue;
        }
        const src = joinPath(fromDir, entry.name);
        if (dest === src || dest.startsWith(`${src}/`)) {
            return `"${entry.name}" can't be moved inside itself.`;
        }
    }
    return null;
}

/**
 * Pick where a selection of files goes, by browsing to it.
 *
 * This replaced a `prompt()` holding a text path. Typing one is error-prone in
 * the ordinary way (typos, a missing leading slash) and in two quieter ways
 * this dialog exists to close: a path that doesn't exist fails with `ENOENT`
 * only after the first file has been sent, and a path that already holds a file
 * of the same name overwrites it without a word — `rename(2)` is happy to
 * clobber. So the destination is browsed, and read before the move: what's
 * already there is listed back as a conflict warning, and a destination on
 * another filesystem is called out, since that turns a move into a copy that
 * can take real time.
 */
export function MoveFilesModal({ serverId, fromDir, entries, onMoved, onClose }: {
    serverId: string;
    /** Folder the selection currently lives in. */
    fromDir: string;
    /** The selected rows, in listing order. */
    entries: DirEntry[];
    /** Called with what actually moved — including a partial batch, so the
     *  listing behind the dialog is right even when some items failed. */
    onMoved: (moved: MovedPath[]) => void;
    onClose: () => void;
}) {
    const [dest, setDest] = useState(fromDir);
    const [destEntries, setDestEntries] = useState<DirEntry[] | "error" | null>(null);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(0);
    const [failures, setFailures] = useState<string[]>([]);
    const [finished, setFinished] = useState(false);
    const mounts = useHostMounts(serverId);

    // What's already in the destination — for the conflict warning, and as the
    // existence check: a folder that can't be listed is a folder we shouldn't
    // start sending files to.
    useEffect(() => {
        let cancelled = false;
        setDestEntries(null);
        if (!dest.startsWith("/")) {
            return;
        }
        api("files", "listDir", { serverId, path: dest })
            .then((res) => { if (!cancelled) setDestEntries(res.entries); })
            .catch(() => { if (!cancelled) setDestEntries("error"); });
        return () => { cancelled = true; };
    }, [serverId, dest]);

    const problem = destProblem(dest, fromDir, entries);
    const conflicts = Array.isArray(destEntries)
        ? entries.filter((e) => destEntries.some((d) => d.name === e.name))
        : [];
    const fromMount = mountForPath(mounts, fromDir);
    const destMount = mountForPath(mounts, dest);
    // Kept as the pair rather than a boolean so the note below can name both
    // filesystems without re-narrowing two nullable lookups.
    const crossFs = fromMount && destMount && fromMount.mountpoint !== destMount.mountpoint
        ? { from: fromMount, to: destMount }
        : null;
    const unreadable = destEntries === "error";
    const canMove = !busy && !finished && !problem && !unreadable && entries.length > 0;

    async function move() {
        setBusy(true);
        setDone(0);
        const moved: MovedPath[] = [];
        const failed: string[] = [];
        for (const entry of entries) {
            const from = joinPath(fromDir, entry.name);
            const to = joinPath(dest, entry.name);
            try {
                await api("files", "rename", { serverId, from, to });
                moved.push({ from, to });
            } catch (err) {
                failed.push(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
            setDone((n) => n + 1);
        }
        setBusy(false);
        onMoved(moved);
        if (failed.length === 0) {
            onClose();
            return;
        }
        // Something didn't make it. Stay open with the reasons: closing would
        // leave a half-moved selection and no account of which half.
        setFailures(failed);
        setFinished(true);
    }

    const what = entries.length === 1 ? `"${entries[0].name}"` : `${entries.length} items`;

    return (
        <Modal title={`Move ${what}`} onClose={onClose} width={620}>
            {failures.length > 0 && (
                <ErrorBanner>
                    {failures.length} of {entries.length} couldn't be moved:
                    <ul className={styles.failures}>{failures.map((f) => <li key={f}>{f}</li>)}</ul>
                </ErrorBanner>
            )}

            <div className={styles.summary}>
                <span className={shared.dim}>From</span>
                <code className={shared.mono}>{fromDir}</code>
            </div>
            <div className={styles.chips}>
                {entries.slice(0, 8).map((e) => (
                    <span key={e.name} className={cx(styles.chip, e.type === "dir" && styles["chip-dir"])} title={e.name}>
                        {e.type === "dir" ? "▸ " : ""}{e.name}
                    </span>
                ))}
                {entries.length > 8 && <span className={shared.dim}>and {entries.length - 8} more</span>}
            </div>

            <label className={shared["login-field"]} style={{ marginTop: 12 }}>
                <span>Destination folder</span>
                <input
                    className={shared.mono}
                    value={dest}
                    spellCheck={false}
                    onChange={(e) => setDest(e.target.value)}
                />
            </label>
            <div style={{ marginTop: 6 }}>
                <DirectoryPicker serverId={serverId} value={dest} onChange={setDest} probe={false} />
            </div>

            <div className={styles.notes}>
                {problem && <p className={styles.bad}>{problem}</p>}
                {!problem && unreadable && <p className={styles.bad}>That folder can't be read — check the path exists.</p>}
                {!problem && !unreadable && conflicts.length > 0 && (
                    <p className={styles.warn}>
                        {conflicts.length === 1
                            ? <>Something called <code className={shared.mono}>{conflicts[0].name}</code> is already there and will be replaced.</>
                            : <>{conflicts.length} items are already there and will be replaced: {conflicts.slice(0, 5).map((c) => c.name).join(", ")}{conflicts.length > 5 ? "…" : ""}</>}
                    </p>
                )}
                {!problem && !unreadable && crossFs && (
                    <p className={styles.warn}>
                        <code className={shared.mono}>{crossFs.to.mountpoint}</code> is a different filesystem
                        from <code className={shared.mono}>{crossFs.from.mountpoint}</code> — the data is copied across
                        and then removed from the old disk, so a large move takes as long as the copy does.
                    </p>
                )}
                {!problem && !unreadable && entries.length > 0 && (
                    <p className={shared.dim}>
                        Lands as <code className={shared.mono}>{joinPath(dest, entries[0].name)}</code>
                        {entries.length > 1 ? `, and ${entries.length - 1} more` : ""}.
                    </p>
                )}
            </div>

            <div className={shared["modal-actions"]} style={{ marginTop: 16, alignItems: "center" }}>
                <button className={shared.btn} type="button" onClick={onClose}>{finished ? "Close" : "Cancel"}</button>
                {!finished && (
                    <button className={cx(shared.btn, shared["btn-primary"])} type="button" disabled={!canMove} onClick={() => void move()}>
                        {busy
                            ? entries.length > 1 ? `Moving ${Math.min(done + 1, entries.length)} of ${entries.length}…` : "Moving…"
                            : `Move ${entries.length > 1 ? `${entries.length} items` : ""}`.trim()}
                    </button>
                )}
            </div>
        </Modal>
    );
}
