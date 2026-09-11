import { useEffect, useState } from "react";
import type { MountInfo } from "@central/shared";
import { api } from "../api";
import { fmtBytes } from "../utils";

/** How long a host's mount table is reused before it's fetched again. Mounts
 *  change when someone plugs a disk in, not between two clicks in a file
 *  browser, so this is about not asking three times on one screen — the file
 *  toolbar, the listing's annotations and a directory picker all want it. */
const TTL_MS = 30_000;

interface Cached {
    at: number;
    promise: Promise<MountInfo[]>;
}

const cache = new Map<string, Cached>();

function fetchMounts(serverId: string): Promise<MountInfo[]> {
    const hit = cache.get(serverId);
    if (hit && Date.now() - hit.at < TTL_MS) {
        return hit.promise;
    }
    // An empty list on failure, deliberately: every caller treats "no mounts" as
    // "don't show the disk affordance", and the most common failure here is not
    // an outage but a user without `panel.mounts.read` — who should simply not
    // see it, rather than meet an error banner in the middle of the file browser.
    const promise = api("files", "getMounts", { serverId })
        .then((state) => (state.available ? state.mounts : []))
        .catch(() => []);
    cache.set(serverId, { at: Date.now(), promise });
    return promise;
}

const listeners = new Set<() => void>();

/** Drop the cached table for a host and re-read it, so a disk mounted a moment
 *  ago appears on the next Refresh rather than on the next page load. */
export function invalidateHostMounts(serverId: string): void {
    cache.delete(serverId);
    for (const notify of listeners) {
        notify();
    }
}

/**
 * The host's real (non-pseudo) mounted filesystems — what `MountsView` shows,
 * borrowed by anything that browses paths so a disk can be picked as a disk
 * instead of guessed at from a directory name.
 *
 * Shared and cached per host (see {@link TTL_MS}); a component that renders
 * before the answer arrives gets an empty list, which is also what a host
 * without `findmnt` and a user without permission to ask get. None of those
 * three cases is worth distinguishing at the call sites.
 */
export function useHostMounts(serverId: string): MountInfo[] {
    // The host is carried alongside the list so a re-render after switching
    // hosts shows nothing rather than the previous host's disks, without
    // blanking the list on a plain refresh of the same host.
    const [state, setState] = useState<{ serverId: string; mounts: MountInfo[] }>({ serverId, mounts: [] });
    // Bumped by `invalidateHostMounts`, which is the whole mechanism: every
    // mounted hook refetches, and the cache miss means exactly one request goes
    // out however many of them there are.
    const [generation, setGeneration] = useState(0);

    useEffect(() => {
        const bump = () => setGeneration((n) => n + 1);
        listeners.add(bump);
        return () => { listeners.delete(bump); };
    }, []);

    useEffect(() => {
        let cancelled = false;
        void fetchMounts(serverId).then((list) => { if (!cancelled) setState({ serverId, mounts: list }); });
        return () => { cancelled = true; };
    }, [serverId, generation]);

    return state.serverId === serverId ? state.mounts : [];
}

/** Index by mountpoint, for "is this directory row a mount?" lookups. */
export function byMountpoint(mounts: MountInfo[]): Map<string, MountInfo> {
    return new Map(mounts.map((m) => [m.mountpoint, m]));
}

/**
 * The filesystem a path lives on: the longest mountpoint that is a prefix of it.
 * `/mnt/tank/media` under mounts `/` and `/mnt/tank` is on `/mnt/tank` — which
 * is the whole point, since `/` is a prefix of everything.
 */
export function mountForPath(mounts: MountInfo[], path: string): MountInfo | null {
    let best: MountInfo | null = null;
    for (const m of mounts) {
        const isPrefix = m.mountpoint === "/" || path === m.mountpoint || path.startsWith(`${m.mountpoint}/`);
        if (isPrefix && (!best || m.mountpoint.length > best.mountpoint.length)) {
            best = m;
        }
    }
    return best;
}

/** The pieces every disk affordance ends up wanting: a 0..1 fill for a meter,
 *  and free/total already formatted. */
export function mountUsage(m: MountInfo): { used: number; free: string; total: string } {
    return {
        used: m.sizeBytes > 0 ? Math.min(1, m.usedBytes / m.sizeBytes) : 0,
        free: fmtBytes(m.availBytes),
        total: fmtBytes(m.sizeBytes),
    };
}
