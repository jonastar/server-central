import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { UserInfo } from "@central/shared";
import { AuthStore } from "../../src/auth";
import type { HostAgent } from "../../src/host-agent";
import { parseSystemUsers, resolveShellUser, systemUserLookup, systemUserSetGroups } from "../../src/features/system-users/system-users";

const PASSWD = [
    "root:x:0:0:root:/root:/bin/bash",
    "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
    "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
    "jonas:x:1000:1000:Jonas:/home/jonas:/bin/bash",
    "deploy:x:1001:1001::/home/deploy:/bin/sh",
].join("\n");

const GROUP = [
    "root:x:0:",
    "docker:x:999:jonas",
    "jonas:x:1000:",
    "deploy:x:1001:",
    "wheel:x:998:jonas,deploy",
].join("\n");

describe("parseSystemUsers", () => {
    test("lists root and regular accounts, hides daemons and nobody", () => {
        const users = parseSystemUsers(PASSWD, GROUP);
        expect(users.map((u) => u.username)).toEqual(["root", "jonas", "deploy"]);
    });

    test("resolves primary group first, then supplementary groups", () => {
        const users = parseSystemUsers(PASSWD, GROUP);
        const jonas = users.find((u) => u.username === "jonas")!;
        expect(jonas.groups).toEqual(["jonas", "docker", "wheel"]);
        expect(jonas.home).toBe("/home/jonas");
        expect(jonas.shell).toBe("/bin/bash");
        expect(jonas.uid).toBe(1000);
    });

    test("tolerates blank lines and malformed entries", () => {
        const users = parseSystemUsers(PASSWD + "\n\nbroken-line\n", GROUP + "\n\n");
        expect(users.map((u) => u.username)).toEqual(["root", "jonas", "deploy"]);
    });

    test("reports the primary group by name when it resolves", () => {
        const users = parseSystemUsers(PASSWD, GROUP);
        expect(users.find((u) => u.username === "jonas")!.primaryGroup).toBe("jonas");
        // daemon's gid 1 has no entry in GROUP → unresolved primary.
        const all = parseSystemUsers(PASSWD, GROUP, true);
        expect(all.find((u) => u.username === "daemon")!.primaryGroup).toBeNull();
    });

    test("includeSystemAccounts lifts the uid filter", () => {
        const users = parseSystemUsers(PASSWD, GROUP, true);
        expect(users.map((u) => u.username)).toEqual(["root", "daemon", "jonas", "deploy", "nobody"]);
    });
});

/** A HostAgent stub whose exec replays canned results and records commands. */
function stubHost(responses: Record<string, { code: number; stdout: string; stderr: string }>): { host: HostAgent; commands: string[] } {
    const commands: string[] = [];
    const host = {
        exec: async (command: string) => {
            commands.push(command);
            const match = Object.entries(responses).find(([prefix]) => command.startsWith(prefix));
            if (!match) {
                throw new Error(`Unexpected command: ${command}`);
            }
            return match[1];
        },
    } as unknown as HostAgent;
    return { host, commands };
}

describe("systemUserLookup", () => {
    test("finds an existing account regardless of uid", async () => {
        const { host } = stubHost({
            "getent passwd deploy": { code: 0, stdout: "deploy:x:1001:1001::/home/deploy:/bin/sh\n", stderr: "" },
            "getent group": { code: 0, stdout: GROUP, stderr: "" },
        });
        const res = await systemUserLookup(host, "deploy");
        expect(res.found).toBe(true);
        expect(res.user!.uid).toBe(1001);
        expect(res.user!.groups).toEqual(["deploy", "wheel"]);
        expect(res.user!.primaryGroup).toBe("deploy");
    });

    test("exit code 2 means missing, not an error", async () => {
        const { host } = stubHost({
            "getent passwd ghost": { code: 2, stdout: "", stderr: "" },
        });
        const res = await systemUserLookup(host, "ghost");
        expect(res.found).toBe(false);
        expect(res.error).toBeUndefined();
    });

    test("other failures surface as errors, not as missing-and-creatable", async () => {
        const { host } = stubHost({
            "getent passwd deploy": { code: 127, stdout: "sh: getent: not found\n", stderr: "" },
        });
        const res = await systemUserLookup(host, "deploy");
        expect(res.found).toBe(false);
        expect(res.error).toMatch(/not found/);
    });

    test("rejects invalid usernames before touching the host", async () => {
        const { host, commands } = stubHost({});
        await expect(systemUserLookup(host, "bad name")).rejects.toThrow(/invalid/i);
        expect(commands).toEqual([]);
    });
});

describe("systemUserSetGroups", () => {
    test("replaces the supplementary list via usermod -G", async () => {
        const { host, commands } = stubHost({ usermod: { code: 0, stdout: "", stderr: "" } });
        await systemUserSetGroups(host, "deploy", ["docker", "wheel"]);
        expect(commands[0]).toContain(`usermod -G "docker,wheel" deploy`);
    });

    test("an empty list clears supplementary groups", async () => {
        const { host, commands } = stubHost({ usermod: { code: 0, stdout: "", stderr: "" } });
        await systemUserSetGroups(host, "deploy", []);
        expect(commands[0]).toContain(`usermod -G "" deploy`);
    });

    test("rejects invalid group names and surfaces usermod failures", async () => {
        const { host } = stubHost({ usermod: { code: 6, stdout: "usermod: group 'nope' does not exist\n", stderr: "" } });
        await expect(systemUserSetGroups(host, "deploy", ["-flag"])).rejects.toThrow(/invalid/i);
        await expect(systemUserSetGroups(host, "deploy", ["nope"])).rejects.toThrow(/does not exist/);
    });
});

describe("resolveShellUser", () => {
    function user(role: UserInfo["role"], systemUser: string | null): UserInfo {
        return { id: "u1", username: "someone", role, createdAt: 0, systemUser };
    }

    test("a mapping always wins, regardless of role", () => {
        expect(resolveShellUser(user("owner", "jonas"))).toBe("jonas");
        expect(resolveShellUser(user("viewer", "deploy"))).toBe("deploy");
    });

    test("unmapped owner/admin fall back to the agent's own user", () => {
        expect(resolveShellUser(user("owner", null))).toBeNull();
        expect(resolveShellUser(user("admin", null))).toBeNull();
    });

    test("unmapped operator/viewer are denied", () => {
        expect(() => resolveShellUser(user("operator", null))).toThrow(/no system user/i);
        expect(() => resolveShellUser(user("viewer", null))).toThrow(/no system user/i);
    });
});

describe("AuthStore.setSystemUser", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-sysuser-test-"));
    });

    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    test("sets, persists across reload, and clears the mapping", async () => {
        const store = new AuthStore(dir);
        await store.init();
        const { user } = await store.setupOwner("alice", "supersecret");
        expect(user.systemUser).toBeNull();

        await store.setSystemUser(user.id, "deploy");
        expect(store.listUsers()[0].systemUser).toBe("deploy");

        const reloaded = new AuthStore(dir);
        await reloaded.init();
        expect(reloaded.listUsers()[0].systemUser).toBe("deploy");

        await reloaded.setSystemUser(user.id, null);
        expect(reloaded.listUsers()[0].systemUser).toBeNull();
    });

    test("trims input and treats empty as clearing", async () => {
        const store = new AuthStore(dir);
        await store.init();
        const { user } = await store.setupOwner("alice", "supersecret");

        await store.setSystemUser(user.id, "  deploy  ");
        expect(store.listUsers()[0].systemUser).toBe("deploy");

        await store.setSystemUser(user.id, "   ");
        expect(store.listUsers()[0].systemUser).toBeNull();
    });

    test("rejects names that aren't valid system usernames", async () => {
        const store = new AuthStore(dir);
        await store.init();
        const { user } = await store.setupOwner("alice", "supersecret");

        await expect(store.setSystemUser(user.id, "-flag")).rejects.toThrow(/invalid/i);
        await expect(store.setSystemUser(user.id, "has space")).rejects.toThrow(/invalid/i);
        await expect(store.setSystemUser(user.id, "semi;colon")).rejects.toThrow(/invalid/i);
    });
});
