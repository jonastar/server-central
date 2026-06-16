import type { DiskUsage, MetricsSnapshot } from "./index";

export interface MetricsSample {
    stat: string;
    mem: string;
    net: string;
    disk: string;
    df: string;
}

interface CpuCounters {
    total: { idle: number; busy: number };
    perCore: Array<{ idle: number; busy: number }>;
}

interface RawCounters {
    ts: number;
    cpu: CpuCounters;
    netRx: number;
    netTx: number;
    diskRead: number;
    diskWrite: number;
}

const DISK_DEVICE_RE = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

const VIRTUAL_FS = new Set([
    "tmpfs", "devtmpfs", "udev", "overlay", "none", "shm",
    "efivarfs", "cgroup", "cgroup2", "proc", "sysfs", "squashfs",
]);

function parseCpu(statText: string): CpuCounters {
    const coreMap = new Map<number, { idle: number; busy: number }>();
    let total = { idle: 0, busy: 0 };
    for (const line of statText.split("\n")) {
        const m = line.match(/^cpu(\d*)\s+(.*)$/);
        if (!m) continue;
        const nums = m[2].trim().split(/\s+/).map(Number);
        const idle = (nums[3] ?? 0) + (nums[4] ?? 0);
        const busy = nums.slice(0, 8).reduce((a, b) => a + (b || 0), 0) - idle;
        if (m[1] === "") total = { idle, busy };
        else coreMap.set(Number(m[1]), { idle, busy });
    }
    const perCore = [...coreMap.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);
    return { total, perCore };
}

function parseMeminfo(text: string): MetricsSnapshot["memory"] {
    const get = (key: string): number => {
        const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
        return m ? Number(m[1]) : 0;
    };
    const totalKb = get("MemTotal");
    const availableKb = get("MemAvailable");
    const swapTotalKb = get("SwapTotal");
    return {
        totalKb,
        availableKb,
        usedKb: Math.max(0, totalKb - availableKb),
        swapTotalKb,
        swapUsedKb: Math.max(0, swapTotalKb - get("SwapFree")),
    };
}

function parseNet(text: string): { rx: number; tx: number } {
    let rx = 0;
    let tx = 0;
    for (const line of text.split("\n")) {
        const m = line.match(/^\s*([^\s:]+):\s*(.*)$/);
        if (!m || m[1] === "lo") continue;
        const f = m[2].trim().split(/\s+/).map(Number);
        rx += f[0] || 0;
        tx += f[8] || 0;
    }
    return { rx, tx };
}

function parseDiskstats(text: string): { read: number; write: number } {
    let read = 0;
    let write = 0;
    for (const line of text.split("\n")) {
        const f = line.trim().split(/\s+/);
        if (f.length < 10 || !DISK_DEVICE_RE.test(f[2])) continue;
        read += (Number(f[5]) || 0) * 512;
        write += (Number(f[9]) || 0) * 512;
    }
    return { read, write };
}

function parseDf(text: string): DiskUsage[] {
    const out: DiskUsage[] = [];
    const seen = new Set<string>();
    for (const line of text.split("\n").slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 6) continue;
        const [filesystem, total, used] = [f[0], Number(f[1]), Number(f[2])];
        const mount = f.slice(5).join(" ");
        if (VIRTUAL_FS.has(filesystem) || filesystem.startsWith("/dev/loop")) continue;
        if (seen.has(mount) || !Number.isFinite(total) || total <= 0) continue;
        seen.add(mount);
        out.push({ filesystem, mount, totalKb: total, usedKb: used });
    }
    return out;
}

function cpuUsagePct(prev: { idle: number; busy: number }, cur: { idle: number; busy: number }): number {
    const dIdle = cur.idle - prev.idle;
    const dBusy = cur.busy - prev.busy;
    const dTotal = dIdle + dBusy;
    if (dTotal <= 0) return 0;
    return Math.min(100, Math.max(0, (dBusy / dTotal) * 100));
}

export class MetricsCollector {
    private prev: RawCounters | null = null;

    reset(): void {
        this.prev = null;
    }

    ingest(sections: MetricsSample): MetricsSnapshot | null {
        const ts = Date.now();
        const cpu = parseCpu(sections.stat);
        const net = parseNet(sections.net);
        const disk = parseDiskstats(sections.disk);

        const counters: RawCounters = { ts, cpu, netRx: net.rx, netTx: net.tx, diskRead: disk.read, diskWrite: disk.write };
        const prev = this.prev;
        this.prev = counters;
        if (!prev) return null;

        const dt = Math.max(0.001, (ts - prev.ts) / 1000);
        const rate = (cur: number, old: number) => Math.max(0, (cur - old) / dt);

        return {
            ts,
            cpu: {
                total: cpuUsagePct(prev.cpu.total, cpu.total),
                perCore: cpu.perCore.map((core, i) =>
                    prev.cpu.perCore[i] ? cpuUsagePct(prev.cpu.perCore[i], core) : 0,
                ),
            },
            memory: parseMeminfo(sections.mem),
            network: { rxBytesPerSec: rate(net.rx, prev.netRx), txBytesPerSec: rate(net.tx, prev.netTx) },
            diskIo: { readBytesPerSec: rate(disk.read, prev.diskRead), writeBytesPerSec: rate(disk.write, prev.diskWrite) },
            disks: parseDf(sections.df),
        };
    }
}
