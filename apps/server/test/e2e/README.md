# The e2e lab

A throwaway fleet of container "hosts" — systemd as PID 1, a real dockerd each,
enrolled into an in-process control plane by the real compiled agent binary.

```sh
bun run --filter @central/server test:e2e
```

First run builds `sc-testnode:latest` (~1 min). After that a full lab boots,
enrolls three agents and forms a Swarm in about 8 seconds.

## Why it exists

`test/integration` covers everything that can be decided from a stubbed
`HostAgent` — parsers, bookkeeping, the wire protocol. What it can't decide is
anything that depends on *which host ran the command*. Swarm is entirely that:
a service is only meaningfully scheduled if the daemons are genuinely separate.

So each node gets its own dockerd, its own `/var/lib/docker`, its own machine
id. Assertions like "exactly one node has this container" mean something here
and are unwriteable anywhere else.

## Requirements

- docker, with permission to run privileged containers
- cgroup v2 on the host (`docker info --format '{{.CgroupVersion}}'`)

`labSupported()` checks both; the tests skip with a reason rather than failing
when the box can't host a lab.

## Writing a test

```ts
const lab = await startLab({ nodes: 3 });

lab.manager                       // node 1, the Swarm leader
lab.agent(node)                   // HostAgent — what feature functions take
lab.entry(node)                   // ServerEntry, incl. probed host capabilities
await node.execOk("docker ps")    // throws with output on non-zero exit
await node.writeFile(p, content)  // stdin, so nothing is shell-mangled
await lab.loadImage("alpine:3.20")// host image -> every node, no registry
```

`loadImage` is not a convenience: the lab has no shared registry, so Swarm can
only place a service on nodes that already hold the image. It also keeps the
suite off the network, which is most of what makes runs repeatable.

## Driving a lab by hand

The same hosts, left running, with the **control plane on node 1** and the other
nodes enrolled into it. Entirely self-contained — it never touches your own dev
control plane or its data.

```sh
bun run lab up            # 3 hosts, a Swarm, control plane on node 1, and the UI
bun run lab web           # just the UI, against an already-running lab
bun run lab status        # containers, units, fleet state, swarm roles
bun run lab sh 2          # a shell on node 2
bun run lab logs 2        # node 2's agent journal (`logs 1 --server` for the
                          # control plane's own)
bun run lab reload        # rebuild from the working tree, restart everything
bun run lab down          # containers, volumes, network
```

`up` and `reload` both end by serving the UI in the foreground — the web server
is part of a lab session, not a separate thing to remember. Ctrl-C stops it and
leaves the hosts running; pass `--no-web` to skip it (scripts, or when you only
want the hosts).

Node 1 runs the bare binary with no arguments, which is how the control plane
actually boots — index.ts only offers the interactive installer on a TTY, and
systemd gives it none. It keeps its dockerd and its Swarm membership, so it is
both the control plane and a managed host, the way a single-box install looks.
Nodes 2 and 3 enroll with tokens minted through the real
`generateNodeInstallCommand` API.

### Developing against it

Everything about a lab session sits beside your own rather than on top of it: the
API is published on **4241** (not 4141) and its dev server runs on **5251** (not
5151), so `bun run dev` and a lab can be up at the same time. `lab up` and `lab
web` set `VITE_API_PORT`, which [api.ts](../../../web/src/api.ts) reads, and
`SC_WEB_PORT`, which vite.config.ts reads.

Log in as `lab` / `labpassword`. Override with `SC_LAB_USER` / `SC_LAB_PASS`,
`SC_LAB_PORT` for the API, and `SC_LAB_WEB_PORT` for the dev server.

For server and agent code, `lab reload` is the loop: recompile from the working
tree, redeploy the control plane and every agent, wait for them back online.
That is ~2.4s end to end, of which the compile is ~0.13s — which is why the lab
deploys a compiled binary instead of bind-mounting the repo and running from
source. A mount would save a fraction of that while giving up the thing the lab
exists for: exercising the artifact that actually ships.

### Debugging a failing test

`SC_LAB_KEEP=1 bun run --filter @central/server test:e2e` skips teardown and
prints the container names and a teardown command, so you can inspect the hosts
a failure left behind.

## Gotchas found the hard way

- `/var/lib/docker` **and** `/var/lib/containerd` need volumes. Overlay can't
  stack on the container's own overlay rootfs, and the failure surfaces as an
  opaque `EINVAL` on the first `docker run`, not at startup.
- The image blanks `/etc/machine-id`, exactly as you would before cloning a VM
  template. Without that every node shares one id and the fleet — which is keyed
  on it — collapses three hosts into one entry.
