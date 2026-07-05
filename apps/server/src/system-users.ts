import type { SystemUserInfo, SystemUsersState, UserInfo } from "@central/shared";
import type { HostAgent } from "./host-agent";

/** Standard POSIX username shape (also what useradd accepts by default). Doubles
 *  as the injection guard for names interpolated into shell commands. */
export const SYSTEM_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}\$?$/;

export function assertSystemUsername(name: string): void {
    if (!SYSTEM_USERNAME_RE.test(name)) {
        throw new Error(`Invalid system username: ${name}`);
    }
}

/**
 * Which OS account a Server Central user's terminal runs as. A mapping always
 * wins (map someone to "root" to grant an explicit root terminal). Unmapped
 * owner/admin keep the agent's own user (root) so first-run setup and admins
 * aren't locked out; unmapped operator/viewer get no terminal at all.
 *
 * Returns the account username, or null for "the agent's own user".
 */
export function resolveShellUser(user: UserInfo): string | null {
    if (user.systemUser) {
        return user.systemUser;
    }
    if (user.role === "owner" || user.role === "admin") {
        return null;
    }
    throw new Error("No system user is mapped to your account — ask an admin to set one in Settings → Users");
}

/** Regular accounts (uid ≥ 1000) plus root; system/daemon accounts and the
 *  nobody user are noise for this view. */
function isListedUid(uid: number): boolean {
    return uid === 0 || (uid >= 1000 && uid !== 65534);
}

/** Parse `getent passwd` + `getent group` output into the listed accounts.
 *  `includeSystemAccounts` disables the uid filter (for single-user lookups,
 *  where a deliberately mapped daemon account still counts). Exported for tests. */
export function parseSystemUsers(passwdOut: string, groupOut: string, includeSystemAccounts = false): Omit<SystemUserInfo, "mappedBy">[] {
    // gid → group name, and username → supplementary group names.
    const groupNames = new Map<number, string>();
    const memberships = new Map<string, string[]>();
    for (const line of groupOut.split("\n")) {
        const [name, , gidStr, memberStr] = line.split(":");
        if (!name || gidStr === undefined) {
            continue;
        }
        groupNames.set(Number(gidStr), name);
        for (const member of (memberStr ?? "").split(",")) {
            if (member) {
                memberships.set(member, [...(memberships.get(member) ?? []), name]);
            }
        }
    }

    const users: Omit<SystemUserInfo, "mappedBy">[] = [];
    for (const line of passwdOut.split("\n")) {
        const [username, , uidStr, gidStr, , home, shell] = line.split(":");
        if (!username || uidStr === undefined) {
            continue;
        }
        const uid = Number(uidStr);
        const gid = Number(gidStr);
        if (!includeSystemAccounts && !isListedUid(uid)) {
            continue;
        }
        const primary = groupNames.get(gid);
        const supplementary = (memberships.get(username) ?? []).filter((g) => g !== primary);
        users.push({
            username,
            uid,
            gid,
            home: home ?? "",
            shell: shell ?? "",
            groups: [...(primary ? [primary] : []), ...supplementary],
            primaryGroup: primary ?? null,
        });
    }
    users.sort((a, b) => a.uid - b.uid);
    return users;
}

export async function systemUsersList(server: HostAgent, scUsers: UserInfo[]): Promise<SystemUsersState> {
    const passwd = await server.exec("getent passwd 2>&1");
    if (passwd.code !== 0) {
        return {
            available: false,
            error: (passwd.stdout + passwd.stderr).trim().split("\n")[0] || "getent unavailable",
            users: [],
        };
    }
    const group = await server.exec("getent group");

    const users = parseSystemUsers(passwd.stdout, group.stdout).map((u) => ({
        ...u,
        mappedBy: scUsers.filter((sc) => sc.systemUser === u.username).map((sc) => sc.username),
    }));
    return { available: true, users };
}

/** Create a regular account with a home directory via useradd. Groups must
 *  already exist (useradd rejects unknown ones with a clear message). */
export async function systemUserCreate(server: HostAgent, username: string, groups: string[]): Promise<void> {
    assertSystemUsername(username);
    for (const group of groups) {
        assertSystemUsername(group);
    }

    // Prefer bash as the login shell when the host has it; useradd's default is
    // often /bin/sh or even nologin, which makes for a poor terminal.
    const shellProbe = await server.exec("test -x /bin/bash && echo /bin/bash || echo /bin/sh");
    const shell = shellProbe.stdout.trim() || "/bin/sh";

    const flags = ["-m", `-s ${shell}`];
    if (groups.length > 0) {
        flags.push(`-G ${groups.join(",")}`);
    }
    const res = await server.exec(`useradd ${flags.join(" ")} ${username} 2>&1`);
    if (res.code !== 0) {
        throw new Error((res.stdout + res.stderr).trim().split("\n").pop() || "useradd failed");
    }
}

/** Whether one account exists on a host, with its details when it does.
 *  getent exits 2 for "no such key"; anything else nonzero is a real failure
 *  (no getent, agent trouble) and must not be mistaken for "missing". */
export async function systemUserLookup(
    server: HostAgent,
    username: string,
): Promise<{ found: boolean; user?: Omit<SystemUserInfo, "mappedBy">; error?: string }> {
    assertSystemUsername(username);
    const passwd = await server.exec(`getent passwd ${username} 2>&1`);
    if (passwd.code === 2) {
        return { found: false };
    }
    if (passwd.code !== 0) {
        return { found: false, error: (passwd.stdout + passwd.stderr).trim().split("\n")[0] || "getent unavailable" };
    }
    const group = await server.exec("getent group");
    const user = parseSystemUsers(passwd.stdout, group.stdout, true).find((u) => u.username === username);
    if (!user) {
        return { found: false, error: "unparseable passwd entry" };
    }
    return { found: true, user };
}

/** Replace an account's supplementary groups (usermod -G; the primary group is
 *  untouched). Groups must already exist; an empty list clears them. */
export async function systemUserSetGroups(server: HostAgent, username: string, groups: string[]): Promise<void> {
    assertSystemUsername(username);
    for (const group of groups) {
        assertSystemUsername(group);
    }
    const res = await server.exec(`usermod -G "${groups.join(",")}" ${username} 2>&1`);
    if (res.code !== 0) {
        throw new Error((res.stdout + res.stderr).trim().split("\n").pop() || "usermod failed");
    }
}
