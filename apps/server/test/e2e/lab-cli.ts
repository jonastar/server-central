/**
 * Hand-driven lab: the same container hosts the e2e tests use, but left running,
 * with the control plane running *on node 1* and the other nodes enrolled into
 * it. Nothing touches your own dev control plane or its data.
 *
 *   bun run lab up          boot the hosts, form a Swarm, run the control plane,
 *                           then serve the web UI against it (--no-web to skip)
 *   bun run lab status      containers, units, fleet state, swarm roles
 *   bun run lab sh 2        a shell on node 2
 *   bun run lab logs 2      follow node 2's agent journal (`logs 1 --server` for
 *                           the control plane's own)
 *   bun run lab reload      rebuild from the working tree, restart everything,
 *                           then serve the UI again (--no-web to skip)
 *   bun run lab web         just the web UI, against an already-running lab
 *   bun run lab down        containers, volumes, network
 *
 * The API is published on the host (4241, not 4141) so it runs alongside your own
 * dev control plane, and its dev server on 5251 rather than 5151 for the same
 * reason — both halves of a lab session sit beside your own, not on top of it.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerEntry } from "@central/shared";
import {
    CLI_PREFIX, CONTROL_PLANE_DATA_DIR,
    bringUpNodes, buildAgent, findNodes, installAgent, installControlPlane, labSupported,
    type LabNode, type NodeSet,
} from "./lab";

/** Pinned so node addresses are identical every run — nice when you're reading logs. */
const SUBNET = "10.199.0.0/24";
/** Throwaway lab, throwaway owner. Printed on every `up`. */
const USER = process.env.SC_LAB_USER ?? "lab";
// The control plane enforces an 8-character minimum, throwaway lab or not.
const PASS = process.env.SC_LAB_PASS ?? "labpassword";
/**
 * Host port the lab's control plane is published on. Deliberately not 4141: that
 * belongs to your own dev control plane, and the whole point is running both.
 */
const PORT = Number(process.env.SC_LAB_PORT ?? 4241);
/** Same idea for the dev server: 5151 belongs to `bun run dev:web`. */
const WEB_PORT = Number(process.env.SC_LAB_WEB_PORT ?? 5251);
const API = `http://127.0.0.1:${PORT}`;

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

// ---- the lab's own control plane ----------------------------------------

let bearer: string | null = null;

async function api<T>(op: string, data: unknown): Promise<T> {
    const res = await fetch(`${API}/${op}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify(data ?? null),
    });
    const text = await res.text();
    if (!res.ok) {
        fail(`${op} failed (${res.status}): ${text}`);
    }
    return text ? JSON.parse(text) as T : undefined as T;
}

/** Wait for the control plane's HTTP API, then create or log into its owner. */
async function authenticate(): Promise<void> {
    let state: { needsSetup: boolean } | null = null;
    for (let i = 0; i < 120; i++) {
        state = await fetch(`${API}/getAuthState`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "null",
        }).then((r) => r.json() as Promise<{ needsSetup: boolean }>).catch(() => null);
        if (state) {
            break;
        }
        await Bun.sleep(500);
    }
    if (!state) {
        fail(`the lab control plane never answered on ${API} — try \`bun run lab logs 1 --server\``);
    }

    const op = state.needsSetup ? "setupOwner" : "login";
    const { token } = await api<{ token: string }>(op, { username: USER, password: PASS });
    bearer = token;
}

async function servers(): Promise<ServerEntry[]> {
    return api<ServerEntry[]>("getServers", null);
}

/** A fresh enrollment token, lifted out of the install command the UI would show. */
async function mintToken(): Promise<string> {
    const { command } = await api<{ command: string }>("generateNodeInstallCommand", { platform: "linux" });
    const match = command.match(/\/node-install\/([^/"?\s]+)/);
    if (!match) {
        fail(`couldn't find a token in the install command:\n${command}`);
    }
    return match[1]!;
}

// ---- bring-up ------------------------------------------------------------

/**
 * Put the working-tree build on every node: the control plane on node 1, agents
 * on the rest. Always rebuilds, so this doubles as the edit → see-it loop.
 */
async function deploy(set: NodeSet): Promise<void> {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-lab-cli-"));
    console.log("building from the working tree…");
    const binPath = await buildAgent(workDir);

    const [cp, ...agents] = set.nodes as [LabNode, ...LabNode[]];
    for (const node of set.nodes) {
        await node.exec("systemctl stop sc-central sc-agent");
        await node.exec("systemctl reset-failed sc-central sc-agent");
    }

    await installControlPlane(cp, { binPath });
    console.log(`  ${cp.name} → control plane (data in ${CONTROL_PLANE_DATA_DIR})`);
    await authenticate();

    // The CA is written by the control plane on first boot; agents need it as
    // their trust anchor, and its leaf covers the node's own address because the
    // container's interface is up when it boots.
    const caPath = path.join(workDir, "ca.crt");
    await fs.writeFile(caPath, await cp.execOk(`cat ${CONTROL_PLANE_DATA_DIR}/tls/ca.crt`));

    const control = `wss://${cp.ip}:4142/node`;
    for (const node of agents) {
        await installAgent(node, { binPath, caCertPath: caPath, control, token: await mintToken() });
        console.log(`  ${node.name} → agent, ${control}`);
    }
    await fs.rm(workDir, { recursive: true, force: true });
}

async function waitOnline(expected: number): Promise<void> {
    for (let i = 0; i < 120; i++) {
        const online = (await servers()).filter((e) => e.status.state === "online");
        if (online.length >= expected) {
            console.log(`\n${online.length} hosts online.`);
            return;
        }
        await Bun.sleep(500);
    }
    console.warn("\nnot everything came online — try `bun run lab logs 2`");
}

function summary(set: NodeSet): void {
    console.log(`\n  API      ${API}   (${USER} / ${PASS})`);
    console.log(`  UI       http://localhost:${WEB_PORT}   (bun run lab web)`);
    console.log(`  manager  ${set.manager.name} (${set.manager.ip})`);
    console.log(`  swarm    docker exec ${set.manager.name} docker node ls`);
}

async function up(args: string[]): Promise<void> {
    const support = await labSupported();
    if (!support.ok) {
        fail(support.reason);
    }
    if (await findNodes()) {
        fail("a lab is already running — `bun run lab reload`, or `bun run lab down` first");
    }

    const nodeArg = args.indexOf("--nodes");
    const count = nodeArg >= 0 ? Number(args[nodeArg + 1]) : 3;

    console.log(`booting ${count} hosts on ${SUBNET}…`);
    const set = await bringUpNodes({
        nodes: count,
        swarm: !args.includes("--no-swarm"),
        prefix: CLI_PREFIX,
        subnet: SUBNET,
        publishApi: PORT,
    });
    await deploy(set);
    // node 1 counts twice over: the control plane manages its own host.
    await waitOnline(count);
    summary(set);
    if (!args.includes("--no-web")) {
        await web();
    }
}

async function reload(args: string[]): Promise<void> {
    const set = await findNodes() ?? fail("no lab running — `bun run lab up` first");
    await deploy(set);
    await waitOnline(set.nodes.length);
    summary(set);
    if (!args.includes("--no-web")) {
        await web();
    }
}

async function status(): Promise<void> {
    const set = await findNodes();
    if (!set) {
        console.log("no lab running");
        return;
    }
    await authenticate();
    const entries = new Map((await servers()).map((e) => [e.status.info?.hostname ?? e.name, e]));
    console.log(`network ${set.network}\n`);
    for (const node of set.nodes) {
        const units = (await node.exec("systemctl is-active sc-central sc-agent")).stdout.trim().split("\n");
        const role = units[0] === "active" ? "control-plane" : "agent";
        const entry = entries.get(node.name);
        console.log(`  ${node.name}  ${node.ip}  ${role.padEnd(13)} fleet=${entry?.status.state ?? "not enrolled"}`);
    }
    const swarm = await set.manager.exec("docker node ls --format '{{.Hostname}} {{.ManagerStatus}}'");
    console.log(`\nswarm:\n${swarm.code === 0 ? swarm.stdout.trimEnd() : "  (not a swarm)"}`);
    summary(set);
}

function nodeAt(set: NodeSet, arg: string | undefined): LabNode {
    const index = Number(arg ?? 1);
    return set.nodes[index - 1] ?? fail(`no node ${index} — lab has ${set.nodes.length}`);
}

/** Hand the terminal over to docker exec / journalctl / vite, inheriting stdio. */
async function passthrough(args: string[], env?: Record<string, string>): Promise<never> {
    const proc = Bun.spawn(args, {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: env ? { ...process.env, ...env } : process.env,
    });
    process.exit(await proc.exited);
}

/**
 * Serve the UI against the lab. Runs in the foreground, so Ctrl-C stops the web
 * server and leaves the lab itself up — the hosts outlive any one dev session.
 */
async function web(): Promise<never> {
    console.log(`\nserving the UI against the lab — Ctrl-C stops it, the lab keeps running\n`);
    return passthrough(["bun", "run", "dev:web"], {
        VITE_API_PORT: String(PORT),
        SC_WEB_PORT: String(WEB_PORT),
    });
}

async function down(): Promise<void> {
    const set = await findNodes();
    if (!set) {
        console.log("no lab running");
        return;
    }
    await set.destroy();
    console.log("lab down");
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
    case "up": await up(rest); break;
    case "reload": await reload(rest); break;
    case "web": {
        await findNodes() ?? fail("no lab running — `bun run lab up` first");
        await web();
        break;
    }
    case "status": await status(); break;
    case "down": await down(); break;
    case "sh": {
        const set = await findNodes() ?? fail("no lab running");
        await passthrough(["docker", "exec", "-it", nodeAt(set, rest[0]).name, "bash"]);
        break;
    }
    case "logs": {
        const set = await findNodes() ?? fail("no lab running");
        const unit = rest.includes("--server") ? "sc-central" : "sc-agent";
        await passthrough(["docker", "exec", "-it", nodeAt(set, rest[0]).name, "journalctl", "-u", unit, "-f", "-n", "80"]);
        break;
    }
    default:
        console.log("usage: bun run lab <up|reload [--no-web]|web|status|sh N|logs N [--server]|down>");
        process.exit(command ? 1 : 0);
}
