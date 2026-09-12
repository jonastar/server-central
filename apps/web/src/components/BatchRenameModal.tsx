import { useMemo, useRef, useState } from "react";
import type { DirEntry } from "@central/shared";
import { api } from "../api";
import { cx, randomId } from "../utils";
import type { MovedPath } from "./MoveFilesModal";
import { ErrorBanner, Modal } from "./ui";
import shared from "../styles/shared.module.css";
import styles from "./BatchRenameModal.module.css";

function joinPath(dir: string, name: string): string {
    return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/** Name without its extension, and the extension (with its dot) or "". A
 *  directory has no extension however many dots it holds, and neither does a
 *  dotfile — `.bashrc` is a name, not an empty stem with a `.bashrc` suffix. */
function splitExt(entry: DirEntry): { stem: string; ext: string } {
    const dot = entry.type === "dir" ? -1 : entry.name.lastIndexOf(".");
    return dot > 0
        ? { stem: entry.name.slice(0, dot), ext: entry.name.slice(dot) }
        : { stem: entry.name, ext: "" };
}

/** Expand the pattern for one entry: each run of `#` becomes the counter,
 *  zero-padded to the run's length (`##` → `01`); `*` is the original name
 *  without its extension; `$1`, `$2`, … are the pieces of that name split on
 *  the separator (a piece that isn't there expands to nothing). */
function expand(pattern: string, n: number, stem: string, parts: string[]): string {
    return pattern.replace(/#+|\*|\$(\d+)/g, (m, idx?: string) => {
        if (idx !== undefined) {
            return parts[Number(idx) - 1] ?? "";
        }
        return m === "*" ? stem : String(n).padStart(m.length, "0");
    });
}

/** The stem cut on the separator, each piece trimmed — `Show - S01 - Ep 3`
 *  on `-` reads as three clean pieces without the user having to type the
 *  spaces around the dash. No separator means one piece: the whole stem. */
function splitParts(stem: string, separator: string): string[] {
    return separator === "" ? [stem] : stem.split(separator).map((p) => p.trim());
}

interface Planned {
    entry: DirEntry;
    to: string;
    /** Why this row can't go ahead, or null. One bad row blocks the whole batch —
     *  a half-applied numbering scheme is worse than none. */
    problem: string | null;
}

/** Starting counter order: natural, so `ep2` numbers before `ep10`. The listing
 *  sorts by plain `localeCompare`, which puts them the other way round — fine
 *  for finding a file, wrong for numbering a season. */
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const sorts = {
    name: (a: DirEntry, b: DirEntry) => natural.compare(a.name, b.name),
    modified: (a: DirEntry, b: DirEntry) => a.modifiedAt - b.modifiedAt || natural.compare(a.name, b.name),
};

/** `list` with the item at `from` moved to sit at `to`. */
function moveItem<T>(list: T[], from: number, to: number): T[] {
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    return next;
}

/**
 * Rename a selection to a numbered pattern — "Romance down E#" over twelve
 * files gives "Romance down E1" … "Romance down E12".
 *
 * Every name is computed and shown before anything is sent, with the problems
 * the host would only report one file in: a name that already exists in the
 * folder (`rename(2)` would replace it without a word), two rows landing on
 * the same name, a slash. When a target is another row's *current* name — a
 * renumbering, say — every row is moved to a temporary name first and then to
 * its final one, so the batch never overwrites one of its own sources.
 *
 * A separator cuts each original name into pieces the pattern can pick from
 * — `Show - S01 - Ep 3` split on `-` gives `$1`, `$2`, `$3` — which covers
 * the "shuffle the parts around" case without asking anyone for a regex.
 *
 * The counter follows the preview's row order, which starts as a natural sort
 * of the names and can be dragged (or nudged with the arrows) into whatever
 * order the numbers should actually run in — the sort a file manager gives
 * you is rarely the sort an episode list wants.
 */
export function BatchRenameModal({ serverId, dir, entries, siblings, onRenamed, onClose }: {
    serverId: string;
    /** Folder the selection lives in. */
    dir: string;
    /** The selected rows. */
    entries: DirEntry[];
    /** Everything in the folder, selected or not — for the conflict check. */
    siblings: DirEntry[];
    /** Called with what actually got renamed, partial batches included. */
    onRenamed: (renamed: MovedPath[]) => void;
    onClose: () => void;
}) {
    const [pattern, setPattern] = useState("");
    const [start, setStart] = useState(1);
    const [keepExt, setKeepExt] = useState(true);
    const [separator, setSeparator] = useState("");
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(0);
    const [failures, setFailures] = useState<string[]>([]);
    const [finished, setFinished] = useState(false);

    const [ordered, setOrdered] = useState(() => [...entries].sort(sorts.name));
    /** Index of the row being dragged, while one is. The ref is the source of
     *  truth: `dragover` fires far faster than React re-renders, and two events
     *  reading a stale index would move the wrong row. The state is for styling. */
    const dragRef = useRef<number | null>(null);
    const [dragging, setDragging] = useState<number | null>(null);
    const locked = busy || finished;

    function move(from: number, to: number) {
        if (from === to || to < 0 || to >= ordered.length) {
            return;
        }
        setOrdered((list) => moveItem(list, from, to));
    }

    const plan: Planned[] = useMemo(() => {
        const sources = new Set(entries.map((e) => e.name));
        const targets = new Map<string, number>();
        const rows = ordered.map((entry, i) => {
            const { stem, ext } = splitExt(entry);
            const to = expand(pattern, start + i, stem, splitParts(stem, separator)) + (keepExt ? ext : "");
            targets.set(to, (targets.get(to) ?? 0) + 1);
            return { entry, to, problem: null as string | null };
        });
        for (const row of rows) {
            if (row.to === "" || row.to === "." || row.to === "..") {
                row.problem = "Empty name";
            } else if (row.to.includes("/")) {
                row.problem = "Names can't contain /";
            } else if ((targets.get(row.to) ?? 0) > 1) {
                row.problem = "Two items would get this name";
            } else if (!sources.has(row.to) && siblings.some((s) => s.name === row.to)) {
                row.problem = "Already exists in this folder";
            }
        }
        return rows;
    }, [ordered, entries, siblings, pattern, start, keepExt, separator]);

    /** What `$1`, `$2`, … stand for, shown against the first row so the tokens
     *  can be picked by eye rather than by counting dashes. */
    const sample = ordered[0] && separator !== "" ? splitParts(splitExt(ordered[0]).stem, separator) : null;

    const changing = plan.filter((p) => p.to !== p.entry.name);
    const problems = plan.filter((p) => p.problem).length;
    const canRename = !busy && !finished && pattern.trim() !== "" && problems === 0 && changing.length > 0;

    async function rename() {
        setBusy(true);
        setDone(0);
        const renamed: MovedPath[] = [];
        const failed: string[] = [];
        const sources = new Set(entries.map((e) => e.name));
        // Only a batch that lands on one of its own current names needs the
        // detour; a plain rename of every row is one request each.
        const staged = changing.some((p) => sources.has(p.to));
        const stageId = randomId();
        // Where each row currently sits: its original name, or the temp name it
        // was parked under. A row that failed to park is dropped, so it keeps its
        // original name rather than being renamed over by phase two.
        let pending = changing.map((p) => ({ ...p, at: p.entry.name }));
        if (staged) {
            const parked: typeof pending = [];
            for (const [i, p] of pending.entries()) {
                const at = `.sc-rename-${stageId}-${i}`;
                try {
                    await api("files", "rename", { serverId, from: joinPath(dir, p.entry.name), to: joinPath(dir, at) });
                    parked.push({ ...p, at });
                } catch (err) {
                    failed.push(`${p.entry.name}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            pending = parked;
        }
        for (const p of pending) {
            const from = joinPath(dir, p.entry.name);
            try {
                await api("files", "rename", { serverId, from: joinPath(dir, p.at), to: joinPath(dir, p.to) });
                renamed.push({ from, to: joinPath(dir, p.to) });
            } catch (err) {
                // If it was parked, it's still parked — say so, or it's lost.
                const where = p.at === p.entry.name ? "" : ` (left as ${p.at})`;
                failed.push(`${p.entry.name}${where}: ${err instanceof Error ? err.message : String(err)}`);
            }
            setDone((n) => n + 1);
        }
        setBusy(false);
        onRenamed(renamed);
        if (failed.length === 0) {
            onClose();
            return;
        }
        setFailures(failed);
        setFinished(true);
    }

    return (
        <Modal title={`Rename ${entries.length} items`} onClose={onClose} width={640}>
            {failures.length > 0 && (
                <ErrorBanner>
                    {failures.length} of {changing.length} couldn't be renamed:
                    <ul className={styles.failures}>{failures.map((f) => <li key={f}>{f}</li>)}</ul>
                </ErrorBanner>
            )}

            <div className={styles.fields}>
                <label className={cx(shared["login-field"], styles.pattern)}>
                    <span>New name</span>
                    <input
                        className={shared.mono}
                        value={pattern}
                        placeholder="Romance down E#"
                        spellCheck={false}
                        autoFocus
                        disabled={locked}
                        onChange={(e) => setPattern(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && canRename) void rename(); }}
                    />
                </label>
                <label className={cx(shared["login-field"], styles.separator)}>
                    <span>Split on</span>
                    <input
                        className={shared.mono}
                        value={separator}
                        placeholder="e.g. -"
                        spellCheck={false}
                        disabled={locked}
                        onChange={(e) => setSeparator(e.target.value)}
                    />
                </label>
                <label className={cx(shared["login-field"], styles.start)}>
                    <span>Start at</span>
                    <input
                        className={shared.mono}
                        type="number"
                        min={0}
                        value={start}
                        disabled={locked}
                        onChange={(e) => setStart(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                    />
                </label>
            </div>
            <div className={styles.hint}>
                <code className={shared.mono}>#</code> counts up (<code className={shared.mono}>##</code> pads to two digits),{" "}
                <code className={shared.mono}>*</code> is the original name
                {separator === ""
                    ? <>; set a separator to pick pieces of it with <code className={shared.mono}>$1</code>, <code className={shared.mono}>$2</code>…</>
                    : "."}
                <label className={styles.keep}>
                    <input type="checkbox" checked={keepExt} disabled={locked} onChange={(e) => setKeepExt(e.target.checked)} />
                    Keep extensions
                </label>
            </div>
            {sample && (
                <div className={styles.pieces}>
                    <span className={shared.dim}>Pieces of <span className={shared["file-name"]}>{ordered[0]!.name}</span>:</span>
                    {sample.map((piece, i) => (
                        <span key={i} className={styles.piece}>
                            <code className={shared.mono}>${i + 1}</code> {piece === "" ? <span className={shared.dim}>(empty)</span> : piece}
                        </span>
                    ))}
                </div>
            )}
            <div className={styles.order}>
                <span className={shared.dim}>Numbered top to bottom — drag rows to reorder, or sort by</span>
                <button type="button" className={styles["sort-btn"]} disabled={locked} onClick={() => setOrdered((l) => [...l].sort(sorts.name))}>name</button>
                <button type="button" className={styles["sort-btn"]} disabled={locked} onClick={() => setOrdered((l) => [...l].sort(sorts.modified))}>modified</button>
                <button type="button" className={styles["sort-btn"]} disabled={locked} onClick={() => setOrdered((l) => [...l].reverse())}>reverse</button>
            </div>

            <div className={styles.preview}>
                <table className={shared["data-table"]}>
                    <thead><tr><th className={styles["col-order"]} /><th>Current</th><th /><th>New</th></tr></thead>
                    <tbody>
                        {plan.map((p, i) => (
                            <tr
                                key={p.entry.name}
                                className={cx(p.problem && styles["row-bad"], dragging === i && styles["row-dragging"], !locked && styles["row-draggable"])}
                                draggable={!locked}
                                onDragStart={(e) => { dragRef.current = i; setDragging(i); e.dataTransfer.effectAllowed = "move"; }}
                                // Reorder live as the row passes over others, so the drop
                                // needs no handler of its own — where it is, is where it lands.
                                onDragOver={(e) => {
                                    e.preventDefault();
                                    const from = dragRef.current;
                                    if (from !== null && from !== i) { move(from, i); dragRef.current = i; setDragging(i); }
                                }}
                                onDragEnd={() => { dragRef.current = null; setDragging(null); }}
                            >
                                <td className={styles["col-order"]}>
                                    <span className={styles.grip} aria-hidden>⋮⋮</span>
                                    <button type="button" className={styles.nudge} aria-label="Move up" disabled={locked || i === 0} onClick={() => move(i, i - 1)}>▲</button>
                                    <button type="button" className={styles.nudge} aria-label="Move down" disabled={locked || i === plan.length - 1} onClick={() => move(i, i + 1)}>▼</button>
                                </td>
                                <td className={cx(shared["file-name"], p.entry.type === "dir" && shared.dir)}>{p.entry.name}</td>
                                <td className={shared.dim}>{busy && i < done ? "✓" : "→"}</td>
                                <td className={shared["file-name"]}>
                                    {pattern ? p.to : <span className={shared.dim}>…</span>}
                                    {p.problem && <span className={styles.problem}>{p.problem}</span>}
                                    {!p.problem && pattern && p.to === p.entry.name && <span className={styles.same}>unchanged</span>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className={shared["modal-actions"]} style={{ alignItems: "center" }}>
                {problems > 0 && <span className={styles.problem}>{problems === 1 ? "1 name has a problem" : `${problems} names have problems`}</span>}
                <span style={{ flex: 1 }} />
                <button className={shared.btn} type="button" onClick={onClose}>{finished ? "Close" : "Cancel"}</button>
                {!finished && (
                    <button className={cx(shared.btn, shared["btn-primary"])} type="button" disabled={!canRename} onClick={() => void rename()}>
                        {busy ? `Renaming ${Math.min(done + 1, changing.length)} of ${changing.length}…` : `Rename ${changing.length || entries.length} items`}
                    </button>
                )}
            </div>
        </Modal>
    );
}
