import { useEffect, useRef, useState } from "react";
import type { MountInfo } from "@central/shared";
import { cx } from "../utils";
import { mountForPath, mountUsage, useHostMounts } from "../hooks/useHostMounts";
import shared from "../styles/shared.module.css";
import styles from "./MountPicker.module.css";

/** Mounts nobody is browsing to on purpose. They stay reachable by walking the
 *  tree — they're just not offered as a place to go. */
function isNoise(m: MountInfo): boolean {
    return m.mountpoint.startsWith("/boot")
        || m.mountpoint.startsWith("/var/lib/docker/")
        || m.mountpoint.startsWith("/snap/")
        || m.fstype === "squashfs";
}

/** `/` first, then the rest by mountpoint — so the list reads like a shelf of
 *  disks with the system one at the top, not alphabetical noise. */
function order(a: MountInfo, b: MountInfo): number {
    if ((a.mountpoint === "/") !== (b.mountpoint === "/")) {
        return a.mountpoint === "/" ? -1 : 1;
    }
    return a.mountpoint.localeCompare(b.mountpoint);
}

/** Label for the trigger: the disk you're on, by its mountpoint's last segment
 *  ("tank" for /mnt/tank), since that's the name people actually call it. */
function shortName(mountpoint: string): string {
    return mountpoint === "/" ? "/" : mountpoint.split("/").filter(Boolean).pop() ?? mountpoint;
}

/**
 * "Which disk am I on, and what else is there" — a dropdown over the host's real
 * mounted filesystems, each with what's left on it.
 *
 * The alternative is walking `/mnt` and reading directory names, which says
 * nothing about which of them is a 8 TB array, which is a stale empty
 * mountpoint, and which is a folder that only looks like a disk.
 *
 * Renders nothing when the host reports no usable mounts — including when the
 * signed-in user can't read them (see `useHostMounts`), so this quietly absents
 * itself rather than offering a control that would fail.
 */
export function MountPicker({ serverId, currentPath, onPick, compact }: {
    serverId: string;
    /** Where the browser currently is, so the mount holding it reads as current. */
    currentPath: string;
    onPick: (mountpoint: string) => void;
    /** Small button, for toolbars that are already full. */
    compact?: boolean;
}) {
    const mounts = useHostMounts(serverId);
    const [open, setOpen] = useState(false);
    const [filter, setFilter] = useState("");
    const wrapRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onDown = (e: MouseEvent) => {
            const target = e.target as Node | null;
            if (!target || !wrapRef.current?.contains(target)) {
                setOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        window.addEventListener("mousedown", onDown, true);
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("mousedown", onDown, true);
            window.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const listed = mounts.filter((m) => !isNoise(m)).sort(order);
    // The mount holding the current path is looked up against every mount, not
    // just the listed ones — being inside a mount this picker doesn't offer is
    // still worth reporting accurately.
    const current = mountForPath(mounts, currentPath);
    if (listed.length === 0) {
        return null;
    }

    // Null when there's nothing to meter — a bind mount or an overlay reports a
    // zero size, and an empty bar next to "0 B free" would read as a full disk.
    const currentUsage = current && current.sizeBytes > 0 ? mountUsage(current) : null;
    const shown = filter
        ? listed.filter((m) => `${m.mountpoint} ${m.device} ${m.fstype}`.toLowerCase().includes(filter.toLowerCase()))
        : listed;

    function pick(mountpoint: string) {
        setOpen(false);
        setFilter("");
        onPick(mountpoint);
    }

    return (
        <div className={styles.wrap} ref={wrapRef}>
            <button
                type="button"
                className={cx(shared.btn, compact && shared["btn-sm"], styles.trigger)}
                onClick={() => setOpen((v) => !v)}
                title={current ? `On ${current.mountpoint} (${current.device}, ${current.fstype})` : "Go to a disk or mount"}
            >
                <span className={styles.glyph} aria-hidden="true">▤</span>
                <span className={styles["trigger-label"]}>{current ? shortName(current.mountpoint) : "Disks"}</span>
                {/* The disk you're on, spelled out rather than left to a hover: which
                    device it is, what it's formatted as, and how much of it is left.
                    Reading those three off the collapsed button is the point of the
                    control — opening it is for going somewhere else. */}
                {current && (
                    <>
                        <span className={cx(shared.mono, styles["trigger-device"])}>{current.device}</span>
                        <span className={cx(shared.badge, shared["badge-muted"], styles["trigger-fs"])}>{current.fstype}</span>
                        {currentUsage && (
                            <>
                                <span className={cx(styles.meter, styles["trigger-meter"])}>
                                    <span
                                        className={cx(styles["meter-fill"], currentUsage.used > 0.9 && styles["meter-full"])}
                                        style={{ width: `${Math.round(currentUsage.used * 100)}%` }}
                                    />
                                </span>
                                <span className={styles["trigger-free"]}>{currentUsage.free} free</span>
                            </>
                        )}
                    </>
                )}
                <span className={styles.caret} aria-hidden="true">▾</span>
            </button>

            {open && (
                <div className={styles.menu} role="menu">
                    {listed.length > 8 && (
                        <input
                            autoFocus
                            className={styles.filter}
                            placeholder="Filter disks…"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                        />
                    )}
                    <div className={styles.list}>
                        {shown.map((m) => {
                            const usage = mountUsage(m);
                            const isCurrent = current?.mountpoint === m.mountpoint;
                            return (
                                <button
                                    key={m.mountpoint}
                                    type="button"
                                    role="menuitem"
                                    className={cx(styles.item, isCurrent && styles.current)}
                                    onClick={() => pick(m.mountpoint)}
                                >
                                    <div className={styles["item-head"]}>
                                        <span className={cx(shared.mono, styles["item-path"])}>{m.mountpoint}</span>
                                        <span className={cx(shared.badge, shared["badge-muted"])}>{m.fstype}</span>
                                    </div>
                                    {m.sizeBytes > 0 && (
                                        <div className={styles["item-meta"]}>
                                            <span className={styles.meter}>
                                                <span
                                                    className={cx(styles["meter-fill"], usage.used > 0.9 && styles["meter-full"])}
                                                    style={{ width: `${Math.round(usage.used * 100)}%` }}
                                                />
                                            </span>
                                            <span className={shared.dim}>{usage.free} free of {usage.total}</span>
                                        </div>
                                    )}
                                    <div className={cx(shared.dim, shared.mono, styles["item-device"])} title={m.device}>{m.device}</div>
                                </button>
                            );
                        })}
                        {shown.length === 0 && <div className={cx(shared.dim, styles.empty)}>No matching disk</div>}
                    </div>
                </div>
            )}
        </div>
    );
}
