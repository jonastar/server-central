import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStore } from "./auth";
import { RoleStore } from "./roles";
import { CONFIG_DIR } from "./config";
import { DEFAULT_SERVER_DATA_DIR } from "./server-install";

// Offline account recovery. The control plane can be configured so that the only
// way in is an external identity provider (see doc/idea_sign_in_methods.md §0),
// which is an accepted risk *because* an operator with shell access can always
// reset a local password. This is that escape hatch — without it, "SSH in and fix
// it" means hand-crafting a Bun.password argon2id hash into users.json.

const KEY_CTRL_C = "\u0003";
const KEY_BACKSPACE = "\u007f";

/** Input read past the end of one prompt's line, held for the next prompt. A
 *  terminal hands over whatever arrived in one chunk, so a paste — or piped
 *  input feeding a pty — can carry the confirmation line in with the password.
 *  Without this it would be consumed and dropped, and the next read would hang. */
let carry = "";

/** Read `--flag <value>`, or null when the flag is absent or has no value. */
function valueFor(argv: string[], flag: string): string | null {
    const i = argv.indexOf(flag);
    return i === -1 ? null : argv[i + 1] ?? null;
}

/**
 * Read a line without echoing it. Falls back to plain stdin when there's no TTY,
 * so the command can be scripted (`echo pw | sc-central --reset-password bob`).
 *
 * Deliberately a `data` listener rather than `for await (… of process.stdin)`:
 * breaking out of that async iterator *destroys* stdin, so the second call (the
 * confirmation prompt) fails with an AbortError. Detaching a listener leaves the
 * stream usable, which is what lets this be called twice.
 */
async function readSecret(label: string): Promise<string> {
    if (!process.stdin.isTTY) {
        return (await Bun.stdin.text()).split("\n")[0] ?? "";
    }
    const stdin = process.stdin;
    process.stdout.write(label);
    stdin.setRawMode(true);
    return new Promise<string>((resolve) => {
        let value = "";
        const finish = (): void => {
            stdin.off("data", onData);
            stdin.setRawMode(false);
            stdin.pause();
            process.stdout.write("\n");
            resolve(value);
        };
        /** Feed characters in; true once a line terminator was reached. */
        const consume = (text: string): boolean => {
            for (let i = 0; i < text.length; i++) {
                const ch = text[i]!;
                if (ch === "\r" || ch === "\n") {
                    const rest = text.slice(i + 1);
                    carry = ch === "\r" && rest.startsWith("\n") ? rest.slice(1) : rest;
                    return true;
                }
                if (ch === KEY_CTRL_C) {
                    // Raw mode swallows the signal, so exit by hand.
                    stdin.setRawMode(false);
                    process.stdout.write("\n");
                    process.exit(130);
                }
                if (ch === KEY_BACKSPACE || ch === "\b") {
                    value = value.slice(0, -1);
                    continue;
                }
                value += ch;
            }
            return false;
        };
        const onData = (chunk: Buffer): void => {
            if (consume(chunk.toString("utf8"))) {
                finish();
            }
        };

        const buffered = carry;
        carry = "";
        if (buffered && consume(buffered)) {
            finish();
            return;
        }
        // Attach before resuming: anything already buffered is emitted the moment
        // the stream flows, and would be dropped if `resume` came first.
        stdin.on("data", onData);
        stdin.resume();
    });
}

/** True when systemd reports the control-plane unit as running. Any failure —
 *  no systemd, no such unit, no systemctl — answers false, which only means the
 *  caller falls back to the printed caution instead of a hard refusal. */
async function controlPlaneRunning(): Promise<boolean> {
    try {
        const proc = Bun.spawn(["systemctl", "is-active", "sc-central"], { stdout: "pipe", stderr: "ignore" });
        return (await new Response(proc.stdout).text()).trim() === "active";
    } catch {
        return false;
    }
}

async function fileExists(file: string): Promise<boolean> {
    try {
        await fs.access(file);
        return true;
    } catch {
        return false;
    }
}

/**
 * `sc-central --reset-password <username> [--data-dir <dir>]`
 *
 * Loads the account store directly off disk, sets a new password, and revokes
 * that user's sessions (`adminSetPassword` does the last two). Never touches the
 * network or the fleet — it must work on a box whose control plane won't boot.
 */
export async function runAuthCli(argv: string[]): Promise<void> {
    const username = valueFor(argv, "--reset-password");
    if (!username) {
        console.error("Usage: sc-central --reset-password <username> [--data-dir <dir>]");
        process.exit(1);
    }
    const dataDir = valueFor(argv, "--data-dir") ?? CONFIG_DIR;

    // Resolve the data dir before anything constructs a store: RoleStore.init()
    // seeds and persists roles.json when it finds none, so pointing at the wrong
    // directory would leave a stray install behind rather than just failing.
    if (!await fileExists(path.join(dataDir, "users.json"))) {
        console.error(`No accounts found in ${path.resolve(dataDir)} (no users.json).`);
        if (dataDir !== DEFAULT_SERVER_DATA_DIR && await fileExists(path.join(DEFAULT_SERVER_DATA_DIR, "users.json"))) {
            console.error(`\nAccounts do exist in ${DEFAULT_SERVER_DATA_DIR} — the installed service's data dir. Retry with:`);
            console.error(`  sc-central --reset-password ${username} --data-dir ${DEFAULT_SERVER_DATA_DIR}`);
        } else {
            console.error("Pass --data-dir, or set SC_DATA_DIR, to point at the installation's data directory.");
        }
        process.exit(1);
    }

    // A running control plane holds every account in memory and rewrites users.json
    // on its next mutation, so an edit made underneath it disappears without a word.
    if (await controlPlaneRunning()) {
        console.error("The sc-central service is running; it would overwrite this change from memory.");
        console.error("Stop it first:\n  systemctl stop sc-central\n  sc-central --reset-password ...\n  systemctl start sc-central");
        process.exit(1);
    }

    const roles = new RoleStore(dataDir);
    await roles.init();
    const auth = new AuthStore(roles, dataDir);
    await auth.init();

    const wanted = username.trim().toLowerCase();
    const known = auth.listUsers();
    const user = known.find((u) => u.username === wanted);
    if (!user) {
        console.error(`No account named "${username}".`);
        if (known.length > 0) {
            console.error("\nKnown accounts:");
            for (const u of known) {
                console.error(`  ${u.username}${u.isOwner ? "  (owner)" : ""}`);
            }
        }
        process.exit(1);
    }

    console.log(`Resetting the password for "${user.username}"${user.isOwner ? " (owner)" : ""} in ${path.resolve(dataDir)}.`);
    const password = await readSecret("New password: ");
    if (password.length < 8) {
        console.error("Password must be at least 8 characters.");
        process.exit(1);
    }
    if (process.stdin.isTTY && await readSecret("Confirm password: ") !== password) {
        console.error("Passwords did not match.");
        process.exit(1);
    }

    await auth.adminSetPassword(user.id, password);
    console.log(`\nPassword updated for "${user.username}". All of that account's sessions were revoked.`);
}
