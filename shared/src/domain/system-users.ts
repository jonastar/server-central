// ---- System users --------------------------------------------------------------
//
// Real OS accounts on a managed host (from `getent passwd`), listed in the
// per-server Users tab. Server Central users can be mapped to one of these
// (`UserInfo.systemUser`); their terminal then runs as that account instead of
// the agent's own user (root). See resolveShellUser in apps/server for the policy.

export interface SystemUserInfo {
    username: string;
    uid: number;
    gid: number;
    home: string;
    shell: string;
    /** Primary group first (when resolvable), then supplementary groups. */
    groups: string[];
    /** Name of the primary group (gid), when it resolves to one. Lets the UI
     *  edit supplementary groups without guessing which entry is the primary. */
    primaryGroup: string | null;
    /** Server Central usernames mapped to this account. */
    mappedBy: string[];
}

export interface SystemUsersState {
    available: boolean;
    error?: string;
    users: SystemUserInfo[];
}

/** Presence of a mapped OS account on one host, for the per-user mapped-hosts
 *  view in Settings → Users. */
export interface SystemUserHostStatus {
    serverId: string;
    serverName: string;
    /** offline = host not connected; error = the lookup itself failed. */
    status: "exists" | "missing" | "offline" | "error";
    error?: string;
    /** Account details when status is "exists". */
    user?: Omit<SystemUserInfo, "mappedBy">;
}


/** Real OS accounts on a host, and creating new ones (owner-only). */
export interface SystemUsersOperations {
    list: { data: { serverId: string }; response: SystemUsersState };
    create: { data: { serverId: string; username: string; groups: string[] }; response: void };
    /** Presence of one OS account across every host in the fleet. */
    hostStatus: { data: { username: string }; response: SystemUserHostStatus[] };
    /** Replace an account's supplementary groups (usermod -G; owner-only). */
    setGroups: { data: { serverId: string; username: string; groups: string[] }; response: void };
}
