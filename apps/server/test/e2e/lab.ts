import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MetricsSnapshot, ServerEntry } from "@central/shared";
import { Fleet } from "../../src/fleet";
import type { HostAgent } from "../../src/host-agent";
import { NodeServer } from "../../src/node-server";
import { ensureTls, localIps, type TlsBundle } from "../../src/tls";
import { poll } from "../integration/helpers";

/**
 * A throwaway fleet of container "hosts", each running systemd + a real dockerd.
 *
 * This is the tier the fake-agent tests can't reach: the agent under test is the
 * real compiled binary, supervised by real systemd, shelling out to a real docker
 * daemon that is genuinely separate per node. That separateness is the point —
 * Swarm only means anything across distinct daemons, and a single shared daemon
 * would make "which node ran this task" untestable.
 *
 * Two ways to use it:
 *   - `startLab()` — nodes plus an in-process control plane. What the tests use.
 *   - `bringUpNodes()` — just the hosts, for `lab-cli.ts` to enroll into the dev
 *     control plane so the web UI has a real multi-node Swarm to render.
 */

const ROOT = path.resolve(import.meta.dir, "../../../..");
const IMAGE = "sc-testnode:latest";
const IMAGE_DIR = path.join(import.meta.dir, "node-image");
/** The pinned official bun the release build uses, when it's been fetched. */
const TOOLCHAIN_BUN = path.join(ROOT, ".toolchain/bun-1.3.10/bun");
/** Fixed prefix for the hand-driven lab, so `lab up` and `lab down` find each
 *  other across invocations without a state file. */
export const CLI_PREFIX = "sc-lab";
/** index.ts's default — the port the control plane listens on *inside* a node. */
export const CONTROL_PLANE_API_PORT = 4141;
/** Where a lab control plane keeps its data dir, inside the node. */
export const CONTROL_PLANE_DATA_DIR = "/var/lib/sc-central";

export interface LabNode {
    /** Container and hostname — also how the node is matched to its fleet entry. */
    name: string;
    /** Address on the lab network, i.e. what Swarm advertises. */
    ip: string;
    /** Fleet entry id (the agent's machine id), resolved once the agent is online. */
    serverId: string;
    /** Run a command inside the node. Never throws on a non-zero exit — assert on `code`. */
    exec(command: string): Promise<RunResult>;
    /** Same, but throws with the command's output when it fails — for setup steps
     *  where a silent failure would surface later as a baffling assertion. */
    execOk(command: string): Promise<string>;
    /** Write a file on the node, content over stdin so nothing is shell-mangled. */
    writeFile(dest: string, content: string): Promise<void>;
    /** The agent's journal, for when a test fails and you need to know why. */
    agentLog(): Promise<string>;
}

/** The hosts, with no control plane attached yet. */
export interface NodeSet {
    prefix: string;
    network: string;
    /** The lab bridge's gateway — the address nodes reach the host on. */
    gateway: string;
    nodes: LabNode[];
    /** Node 1 — the Swarm manager when brought up with `swarm: true`. */
    manager: LabNode;
    /** Copy an image from the host's daemon into every node's daemon.
     *
     *  The lab deliberately has no shared registry, so a Swarm service can only
     *  be scheduled on a node that already holds its image. Shipping it over
     *  `docker save | docker load` also keeps the suite off the network, which
     *  is what makes run-to-run behaviour repeatable. */
    loadImage(ref: string): Promise<void>;
    /** Remove the containers, their anonymous volumes, and the network. */
    destroy(): Promise<void>;
}

export interface Lab extends NodeSet {
    fleet: Fleet;
    server: NodeServer;
    /** The control plane's handle on a node — what every feature function takes. */
    agent(node: LabNode): HostAgent;
    entry(node: LabNode): ServerEntry;
    stop(): Promise<void>;
}

export interface LabOptions {
    /** Default 3: one manager and two workers. */
    nodes?: number;
    /** Form a Swarm across the nodes at startup. Default true. */
    swarm?: boolean;
    /** Container/network name prefix. Defaults to a per-run unique one. */
    prefix?: string;
    /** Fixed CIDR for the lab network, so node addresses are the same every run. */
    subnet?: string;
    /**
     * Publish node 1's control-plane API on this host port. Set by the
     * hand-driven lab so the browser (and the vite dev server) can reach the
     * control plane running *inside* the lab.
     */
    publishApi?: number;
}

export interface RunResult { stdout: string; stderr: string; code: number }

/** Spawn argv directly — no shell. Used for everything aimed at a node, so a
 *  multi-line script survives instead of being re-split by a second shell. */
export async function run(args: string[], stdin?: string): Promise<RunResult> {
    const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, code };
}

/** Host-side helper for commands that genuinely want a shell (pipes). */
async function sh(command: string): Promise<RunResult> {
    const proc = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { stdout, stderr, code };
}

async function shOk(command: string): Promise<string> {
    const res = await sh(command);
    if (res.code !== 0) {
        throw new Error(`command failed (${res.code}): ${command}\n${res.stderr || res.stdout}`);
    }
    return res.stdout;
}

/**
 * Whether this machine can host a lab at all. Checked by the tests so a box
 * without docker skips with a reason instead of failing fifteen assertions.
 */
export async function labSupported(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const info = await sh("docker info --format '{{.CgroupVersion}}' 2>&1");
    if (info.code !== 0) {
        return { ok: false, reason: `docker isn't usable here: ${info.stdout.trim() || info.stderr.trim()}` };
    }
    if (info.stdout.trim() !== "2") {
        return { ok: false, reason: `systemd-in-container needs cgroup v2, host reports v${info.stdout.trim()}` };
    }
    return { ok: true };
}

/**
 * Compile the agent the nodes will run — always from the working tree, which is
 * the whole point when you're developing agent-side code. Prefers the pinned
 * official bun (the exact artifact `build-agent.sh` ships); falls back to the
 * bun running this, fine because the binary only ever has to run inside our own
 * Debian image, not on the arbitrary hosts the release binary targets.
 */
export async function buildAgent(outDir: string): Promise<string> {
    const out = path.join(outDir, "sc-agent");
    const bun = await fs.access(TOOLCHAIN_BUN).then(() => TOOLCHAIN_BUN).catch(() => process.execPath);
    await shOk(`cd ${ROOT} && ${bun} build --compile --target=bun-linux-x64 apps/server/src/index.ts --outfile ${out}`);
    return out;
}

async function ensureImage(): Promise<void> {
    if ((await sh(`docker image inspect ${IMAGE}`)).code === 0) {
        return;
    }
    console.log(`building ${IMAGE} (first run only, ~1 min)…`);
    await shOk(`docker build -t ${IMAGE} ${IMAGE_DIR}`);
}

function makeNode(name: string, ip: string): LabNode {
    return {
        name,
        ip,
        serverId: "",
        exec: (command) => run(["docker", "exec", name, "sh", "-c", command]),
        execOk: async (command) => {
            const res = await run(["docker", "exec", name, "sh", "-c", command]);
            if (res.code !== 0) {
                throw new Error(`${name}: \`${command}\` exited ${res.code}\n${res.stderr || res.stdout}`);
            }
            return res.stdout;
        },
        writeFile: async (dest, content) => {
            const res = await run(["docker", "exec", "-i", name, "sh", "-c", `cat > "${dest}"`], content);
            if (res.code !== 0) {
                throw new Error(`${name}: writing ${dest} failed\n${res.stderr}`);
            }
        },
        agentLog: async () => (await sh(`docker exec ${name} journalctl -u sc-agent --no-pager`)).stdout,
    };
}

function nodeSet(prefix: string, network: string, gateway: string, nodes: LabNode[]): NodeSet {
    return {
        prefix,
        network,
        gateway,
        nodes,
        manager: nodes[0]!,
        loadImage: async (ref) => {
            if ((await sh(`docker image inspect ${ref}`)).code !== 0) {
                await shOk(`docker pull ${ref}`);
            }
            await Promise.all(nodes.map((node) =>
                shOk(`docker save ${ref} | docker exec -i ${node.name} docker load`),
            ));
        },
        destroy: async () => {
            for (const node of nodes) {
                // -v: the image-store volumes are anonymous, so without it every
                // run leaves a couple of GB behind.
                await sh(`docker rm -f -v ${node.name}`);
            }
            await sh(`docker network rm ${network}`);
        },
    };
}

/**
 * Create the lab network if it isn't there. Idempotent on purpose: the dev
 * control plane only learns the gateway address if the network exists when it
 * boots, so the network legitimately outlives any particular lab.
 */
export async function ensureNetwork(network: string, subnet?: string): Promise<string> {
    if ((await sh(`docker network inspect ${network}`)).code !== 0) {
        await shOk(`docker network create ${subnet ? `--subnet ${subnet} ` : ""}${network}`);
    }
    return (await shOk(`docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' ${network}`)).trim();
}

/** Re-attach to a lab that is already running, by prefix. Empty when none is up. */
export async function findNodes(prefix = CLI_PREFIX): Promise<NodeSet | null> {
    const network = `${prefix}-net`;
    const names = (await sh(`docker ps --filter "name=^/${prefix}-[0-9]+$" --format '{{.Names}}'`))
        .stdout.trim().split("\n").filter(Boolean).sort();
    if (names.length === 0) {
        return null;
    }
    const nodes: LabNode[] = [];
    for (const name of names) {
        const ip = (await shOk(
            `docker inspect -f '{{(index .NetworkSettings.Networks "${network}").IPAddress}}' ${name}`,
        )).trim();
        nodes.push(makeNode(name, ip));
    }
    const gateway = (await shOk(
        `docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' ${network}`,
    )).trim();
    return nodeSet(prefix, network, gateway, nodes);
}

/** Boot the hosts and (optionally) form a Swarm. No control plane involved. */
export async function bringUpNodes(options: LabOptions = {}): Promise<NodeSet> {
    const count = options.nodes ?? 3;
    const swarm = options.swarm ?? true;
    const prefix = options.prefix ?? `sc-lab-${Math.random().toString(36).slice(2, 8)}`;
    const network = `${prefix}-net`;

    await ensureImage();
    await ensureNetwork(network, options.subnet);

    const nodes: LabNode[] = [];
    const partial = () => nodeSet(prefix, network, "", nodes);

    try {
        for (let i = 1; i <= count; i++) {
            const name = `${prefix}-${i}`;
            // Volumes for the image stores: neither dockerd's overlay2 driver nor
            // containerd's overlayfs snapshotter can stack on the container's own
            // overlay rootfs, and the failure mode is an opaque EINVAL at first
            // `docker run` rather than anything at startup.
            const publish = i === 1 && options.publishApi ? ` -p ${options.publishApi}:${CONTROL_PLANE_API_PORT}` : "";
            await shOk(
                `docker run -d --privileged --name ${name} --hostname ${name} --network ${network}` +
                ` --tmpfs /run --tmpfs /run/lock${publish}` +
                ` --mount type=volume,dst=/var/lib/docker --mount type=volume,dst=/var/lib/containerd` +
                ` ${IMAGE}`,
            );
            const ip = (await shOk(
                `docker inspect -f '{{(index .NetworkSettings.Networks "${network}").IPAddress}}' ${name}`,
            )).trim();
            nodes.push(makeNode(name, ip));
        }

        // systemd brings dockerd up asynchronously; nothing else can proceed until
        // every daemon answers.
        for (const node of nodes) {
            await poll(async () => (await node.exec("docker info")).code === 0, {
                label: `dockerd ready on ${node.name}`,
                timeoutMs: 90_000,
                intervalMs: 500,
            });
        }

        if (swarm && nodes.length > 0) {
            const [manager, ...workers] = nodes as [LabNode, ...LabNode[]];
            await manager.execOk(`docker swarm init --advertise-addr ${manager.ip}`);
            const token = (await manager.execOk("docker swarm join-token -q worker")).trim();
            for (const worker of workers) {
                await worker.execOk(`docker swarm join --token ${token} ${manager.ip}:2377`);
            }
        }

        const gateway = (await shOk(
            `docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' ${network}`,
        )).trim();
        return nodeSet(prefix, network, gateway, nodes);
    } catch (err) {
        await partial().destroy();
        throw err;
    }
}

/**
 * Put the working-tree agent on a node and start it as a systemd service.
 *
 * systemd-run rather than a bare `docker exec -d`: the agent ships as a systemd
 * service, so run it as one — and it makes `systemctl restart sc-agent`
 * available to reconnect tests and to anyone poking at a live lab.
 */
export async function installAgent(node: LabNode, opts: {
    binPath: string;
    caCertPath: string;
    control: string;
    token: string;
}): Promise<void> {
    await shOk(`docker cp ${opts.binPath} ${node.name}:/usr/local/bin/sc-agent`);
    await shOk(`docker cp ${opts.caCertPath} ${node.name}:/etc/sc-ca.crt`);
    await shOk(
        `docker exec ${node.name} systemd-run --unit=sc-agent --description="Server Central agent"` +
        ` /usr/local/bin/sc-agent --agent --control ${opts.control} --token ${opts.token} --cert /etc/sc-ca.crt`,
    );
}

/**
 * Run the control plane *on* a node, from the same working-tree binary.
 *
 * The bare binary with no args boots the control plane (index.ts only offers the
 * interactive installer on a TTY, and systemd gives it none), so this is the
 * shipped entry point, not a test-only path. The node keeps its dockerd and its
 * Swarm membership, so node 1 is both the control plane and a managed host —
 * which is how a single-box install actually looks.
 */
export async function installControlPlane(node: LabNode, opts: { binPath: string }): Promise<void> {
    await shOk(`docker cp ${opts.binPath} ${node.name}:/usr/local/bin/sc-central`);
    await shOk(
        `docker exec ${node.name} systemd-run --unit=sc-central --description="Server Central control plane"` +
        ` --setenv=SC_DATA_DIR=${CONTROL_PLANE_DATA_DIR}` +
        ` /usr/local/bin/sc-central`,
    );
}

/** Nodes plus an in-process control plane, with every agent enrolled and online. */
export async function startLab(options: LabOptions = {}): Promise<Lab> {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-lab-"));
    const agentBin = await buildAgent(workDir);
    const set = await bringUpNodes(options);

    try {
        // The leaf must carry the lab network's gateway IP — that's the address the
        // agents dial the control plane on, and they verify it. The network already
        // exists, so localIps() has picked its bridge up.
        const tls: TlsBundle = await ensureTls(path.join(workDir, "tls"), { lanIps: localIps() });

        const fleet = new Fleet(() => {});
        const onMetrics = (_serverId: string, _snapshot: MetricsSnapshot) => {};
        const server = new NodeServer(fleet, tls, set.gateway, null, onMetrics, null, 0);
        server.start();

        const control = `wss://${set.gateway}:${server.port}/node`;
        for (const node of set.nodes) {
            const { token } = server.mintToken();
            await installAgent(node, { binPath: agentBin, caCertPath: tls.caCertPath, control, token });
        }

        const byHostname = new Map<string, ServerEntry>();
        await poll(
            () => {
                byHostname.clear();
                for (const entry of fleet.entries()) {
                    const hostname = entry.status.info?.hostname;
                    if (entry.status.state === "online" && hostname) {
                        byHostname.set(hostname, entry);
                    }
                }
                return byHostname.size === set.nodes.length;
            },
            { label: `all ${set.nodes.length} agents online`, timeoutMs: 60_000, intervalMs: 250 },
        ).catch(async (err) => {
            const logs = await Promise.all(set.nodes.map(async (n) => `--- ${n.name} ---\n${await n.agentLog()}`));
            throw new Error(`${err}\n${logs.join("\n")}`);
        });

        for (const node of set.nodes) {
            node.serverId = byHostname.get(node.name)!.id;
        }

        return {
            ...set,
            fleet,
            server,
            agent: (node) => fleet.get(node.serverId),
            entry: (node) => {
                const found = fleet.entries().find((e) => e.id === node.serverId);
                if (!found) {
                    throw new Error(`${node.name} is no longer in the fleet`);
                }
                return found;
            },
            stop: async () => {
                server.stop();
                // SC_LAB_KEEP leaves the hosts running after a failing test so you
                // can go and look at them; `bun run lab down` cleans up after.
                if (process.env.SC_LAB_KEEP) {
                    console.log(`\nSC_LAB_KEEP set — lab left running: ${set.nodes.map((n) => n.name).join(" ")}`);
                    console.log(`  inspect:  docker exec -it ${set.manager.name} bash`);
                    console.log(`  teardown: docker rm -f -v ${set.nodes.map((n) => n.name).join(" ")} && docker network rm ${set.network}`);
                    return;
                }
                await set.destroy();
                await fs.rm(workDir, { recursive: true, force: true });
            },
        };
    } catch (err) {
        await set.destroy();
        throw err;
    }
}
