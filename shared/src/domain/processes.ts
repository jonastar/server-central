// ---- Processes ---------------------------------------------------------------

export interface ProcessInfo {
    pid: number;
    user: string;
    cpuPct: number;
    memPct: number;
    rssKb: number;
    started: string;
    command: string;
}


export interface ProcessesOperations {
    list: { data: { serverId: string }; response: ProcessInfo[] };
}
