import { expect, test } from "bun:test";
import { composeConfig, composeStackAction, getComposeStackStatus } from "../../src/features/docker/docker";
import type { HostAgent } from "../../src/host-agent";

// `docker compose config --format json` is asked for, but some compose builds
// print the canonical YAML instead — which used to leave every App looking
// empty (no services declared, so the status badge said "down" even with
// containers running). Both output shapes have to work.

/** A HostAgent stand-in that replays canned output — no docker, no fleet. The
 *  reply sees the argv joined into a command line, which reads better in a
 *  predicate than an array, plus the options: `cwd` is set for exactly the
 *  commands that run inside the stack's directory. */
function fakeAgent(
    reply: (command: string, opts?: { cwd?: string }) => { stdout: string; stderr?: string; code?: number },
): HostAgent {
    const run = async (argv: string[], opts?: { cwd?: string }) => {
        const res = reply(argv.join(" "), opts);
        return { stdout: res.stdout, stderr: res.stderr ?? "", code: res.code ?? 0 };
    };
    // Streaming verbs go through `runStream`; with no listener the output is
    // simply not forwarded, so a one-shot reply stands in fine.
    return { run, runStream: (argv: string[], _onChunk: unknown, opts?: { cwd?: string }) => run(argv, opts) } as unknown as HostAgent;
}

const YAML_OUTPUT = `name: bl
services:
  db:
    container_name: postgres
    image: postgres:16.2-alpine
    networks:
      default: null
    restart: always
    volumes:
      - type: volume
        source: db
        target: /var/lib/postgresql/data
        volume: {}
  webapi:
    container_name: bl-webapi
    image: botloader/backend:latest
    volumes:
      - type: bind
        source: /etc/botloader/nginx.conf
        target: /etc/nginx/nginx.conf
networks:
  default:
    name: bl_default
volumes:
  db:
    name: bl_db
    driver: local
`;

const JSON_OUTPUT = JSON.stringify({
    name: "bl",
    services: { db: { image: "postgres:16.2-alpine" } },
    volumes: { db: { driver: "local" } },
});

test("composeConfig reads the JSON output", async () => {
    const { config, error } = await composeConfig(fakeAgent(() => ({ stdout: JSON_OUTPUT })), "/opt/bl", "compose.yaml", "bl");
    expect(error).toBeUndefined();
    expect(Object.keys(config?.services ?? {})).toEqual(["db"]);
});

test("composeConfig falls back to the YAML output when --format json is ignored", async () => {
    const { config, error } = await composeConfig(fakeAgent(() => ({ stdout: YAML_OUTPUT })), "/opt/bl", "compose.yaml", "bl");
    expect(error).toBeUndefined();
    expect(Object.keys(config?.services ?? {})).toEqual(["db", "webapi"]);
    expect(Object.keys(config?.volumes ?? {})).toEqual(["db"]);
    // The long-form volume entries drive import's external-bind-mount warning.
    expect(config?.services?.webapi?.volumes?.[0]).toMatchObject({ type: "bind", source: "/etc/botloader/nginx.conf" });
});

test("composeConfig still reports genuinely unusable output as an error", async () => {
    const { config, error } = await composeConfig(fakeAgent(() => ({ stdout: "\t\tnot: [valid", stderr: "", code: 0 })), "/opt/bl", "compose.yaml", "bl");
    expect(config).toBeNull();
    expect(error).toBeTruthy();
});

test("getComposeStackStatus merges YAML-shaped config with compose ps", async () => {
    const status = await getComposeStackStatus(
        fakeAgent((command) => command.includes(" ps ")
            ? { stdout: JSON.stringify({ Service: "db", Image: "postgres:16.2-alpine", State: "running" }) }
            : { stdout: YAML_OUTPUT }),
        "/opt/bl", "compose.yaml", "bl",
    );
    expect(status.services.map((s) => s.name)).toEqual(["db", "webapi"]);
    expect(status.status).toBe("partial");
});

// A migrations service that exited 0 under `restart: no` has done its job; the
// stack is running, not partial, and the service says so rather than "exited".
test("getComposeStackStatus reads a finished one-shot as completed, not down", async () => {
    const status = await getComposeStackStatus(
        fakeAgent((command) => {
            if (command.includes(" ps ")) {
                return { stdout: [
                    JSON.stringify({ ID: "aaa111", Service: "db", State: "running", ExitCode: 0 }),
                    JSON.stringify({ ID: "bbb222", Service: "migrations", State: "exited", Status: "Exited (0) 2 hours ago", ExitCode: 0 }),
                ].join("\n") };
            }
            if (command.startsWith("docker inspect")) {
                return { stdout: "bbb222" + "0".repeat(58) + " no\n" };
            }
            return { stdout: JSON.stringify({ services: { db: {}, migrations: {} } }) };
        }),
        "/opt/bl", "compose.yaml", "bl",
    );
    expect(status.status).toBe("running");
    expect(status.services.find((s) => s.name === "migrations")).toMatchObject({ up: false, completed: true });
    expect(status.services.find((s) => s.name === "db")?.completed).toBeUndefined();
});

test("getComposeStackStatus keeps an exit-0 service under restart: always as down", async () => {
    const status = await getComposeStackStatus(
        fakeAgent((command) => {
            if (command.includes(" ps ")) {
                return { stdout: [
                    JSON.stringify({ ID: "aaa111", Service: "db", State: "running", ExitCode: 0 }),
                    JSON.stringify({ ID: "bbb222", Service: "web", State: "exited", ExitCode: 0 }),
                ].join("\n") };
            }
            if (command.startsWith("docker inspect")) {
                return { stdout: "bbb222" + "0".repeat(58) + " always\n" };
            }
            return { stdout: JSON.stringify({ services: { db: {}, web: {} } }) };
        }),
        "/opt/bl", "compose.yaml", "bl",
    );
    expect(status.status).toBe("partial");
    expect(status.services.find((s) => s.name === "web")?.completed).toBeUndefined();
});

// ---- status when the stack's directory is gone ------------------------------
//
// Every compose command runs with the stack's directory as its cwd, so none of
// them can start once that directory disappears — which says nothing about
// whether the containers are still up, and they usually are (folder deleted out
// from under a live stack, unmounted volume). The compose labels on the
// containers survive, so status falls back to plain `docker ps` filtered by
// project.

const PS_JSON_LINE = JSON.stringify({
    ID: "b672416efadf",
    Names: "static-page-test-web-1",
    Image: "nginx:alpine",
    State: "running",
    Status: "Up 3 days",
    Ports: "0.0.0.0:8081->80/tcp, :::8081->80/tcp",
    CreatedAt: "2026-08-19 10:00:00 +0000 UTC",
    Labels: "com.docker.compose.project=static-page-test,com.docker.compose.service=web",
});

test("a running stack whose directory is gone still reports running", async () => {
    const agent = fakeAgent((command, opts) => {
        // Anything that runs in the stack dir can't start — that's what a
        // missing dir does; plain `docker ps` has no cwd and still works.
        if (opts?.cwd) {
            return { stdout: "", stderr: "no such file or directory", code: 127 };
        }
        if (command.includes("docker ps -a --filter label=com.docker.compose.project=static-page-test")) {
            return { stdout: PS_JSON_LINE };
        }
        return { stdout: "", code: 1 };
    });

    const status = await getComposeStackStatus(agent, "/opt/sc-apps/static-page-test", "compose.yaml", "static-page-test");

    expect(status.status).toBe("running");
    expect(status.services).toHaveLength(1);
    expect(status.services[0]!.name).toBe("web");
    expect(status.services[0]!.containerId).toBe("b672416efadf");
    expect(status.services[0]!.up).toBe(true);
    // The IPv4/IPv6 bind of one published port is a single mapping, as with
    // compose's own structured Publishers.
    expect(status.services[0]!.ports).toBe("8081→80");
});

test("a gone directory with no containers left is genuinely down", async () => {
    const agent = fakeAgent((_command, opts) => {
        if (opts?.cwd) {
            return { stdout: "", stderr: "no such file or directory", code: 127 };
        }
        return { stdout: "" };   // docker ps: nothing carries the label
    });

    const status = await getComposeStackStatus(agent, "/gone", "compose.yaml", "ghost");

    expect(status.status).toBe("down");
    expect(status.services).toEqual([]);
});

test("containers running for services the compose file doesn't declare still show", async () => {
    const agent = fakeAgent((command) => {
        if (command.includes("config --format json")) {
            return { stdout: JSON.stringify({ name: "p", services: { web: { image: "nginx" } } }) };
        }
        if (command.includes(" ps --format json")) {
            return {
                stdout: [
                    JSON.stringify({ ID: "aaa", Service: "web", Image: "nginx", State: "running" }),
                    // Left over from an earlier revision of the compose file.
                    JSON.stringify({ ID: "bbb", Service: "worker", Image: "busybox", State: "running" }),
                ].join("\n"),
            };
        }
        return { stdout: "" };
    });

    const status = await getComposeStackStatus(agent, "/opt/p", "compose.yaml", "p");

    expect(status.services.map((s) => s.name)).toEqual(["web", "worker"]);
    expect(status.status).toBe("running");
});

// ---- status when the compose file can't be read at all -----------------------
//
// "No services declared yet" is a claim about the compose file, and the stack
// view can only make it when compose actually read the file. A published
// compose file that interpolates variables from a sibling `.env` — Immich's is
// the one people hit — fails `config` outright until that file exists, and
// reporting the empty result as "nothing declared" contradicts a file that
// plainly declares four services.

/** What `docker compose config` prints for Immich's compose file with no `.env`
 *  beside it: one warning per uninterpolated variable, then the real failure. */
const IMMICH_NO_ENV_STDERR = [
    'time="2026-09-10T21:46:37+02:00" level=warning msg="The \\"DB_DATA_LOCATION\\" variable is not set. Defaulting to a blank string."',
    'time="2026-09-10T21:46:37+02:00" level=warning msg="The \\"DB_PASSWORD\\" variable is not set. Defaulting to a blank string."',
    'time="2026-09-10T21:46:37+02:00" level=warning msg="The \\"DB_USERNAME\\" variable is not set. Defaulting to a blank string."',
    'time="2026-09-10T21:46:37+02:00" level=warning msg="The \\"DB_DATABASE_NAME\\" variable is not set. Defaulting to a blank string."',
    'time="2026-09-10T21:46:37+02:00" level=warning msg="The \\"UPLOAD_LOCATION\\" variable is not set. Defaulting to a blank string."',
    "invalid spec: :/data: empty section between colons",
].join("\n");

test("a compose file that won't parse reports why, instead of looking empty", async () => {
    const agent = fakeAgent((command) => command.includes("config --format json")
        ? { stdout: "", stderr: IMMICH_NO_ENV_STDERR, code: 1 }
        : { stdout: "" });

    const status = await getComposeStackStatus(agent, "/opt/sc-apps/immich", "compose.yaml", "immich");

    expect(status.services).toEqual([]);
    expect(status.status).toBe("down");
    // Compose's per-variable warnings are recovered-from chatter, and there are
    // enough of them to push the real failure past the length cap — the caller
    // renders this string, so the cause has to survive to the front of it.
    expect(status.error).toBe("invalid spec: :/data: empty section between colons");
});

test("a readable compose file reports no error", async () => {
    const status = await getComposeStackStatus(
        fakeAgent((command) => command.includes("config --format json") ? { stdout: JSON_OUTPUT } : { stdout: "" }),
        "/opt/bl", "compose.yaml", "bl",
    );

    expect(status.error).toBeUndefined();
    expect(status.services.map((s) => s.name)).toEqual(["db"]);
});

test("containers still running are reported even when the compose file won't parse", async () => {
    const agent = fakeAgent((command) => {
        if (command.includes("config --format json")) {
            return { stdout: "", stderr: IMMICH_NO_ENV_STDERR, code: 1 };
        }
        if (command.includes(" ps --format json")) {
            return { stdout: JSON.stringify({ ID: "ccc", Service: "immich-server", Image: "immich-server:release", State: "running" }) };
        }
        return { stdout: "" };
    });

    const status = await getComposeStackStatus(agent, "/opt/sc-apps/immich", "compose.yaml", "immich");

    expect(status.services.map((s) => s.name)).toEqual(["immich-server"]);
    expect(status.status).toBe("running");
    expect(status.error).toBeTruthy();
});

// `down` on a stack whose directory is gone: compose can't start there, so the
// containers and network are removed by project label instead. Without this an
// unregister leaves the exited containers behind and `syncHost` adopts the
// project straight back — the "ghost stack" that can't be deleted.

test("down on a gone directory removes the project's containers and networks by label", async () => {
    const ran: string[] = [];
    const agent = fakeAgent((command, opts) => {
        ran.push(command);
        if (command === "test -d /opt/sc-apps/static-page-test") {
            return { stdout: "", code: 1 };
        }
        if (opts?.cwd) {
            return { stdout: "", stderr: "Working directory /opt/sc-apps/static-page-test is unavailable", code: 127 };
        }
        if (command === "docker ps -aq --filter label=com.docker.compose.project=static-page-test") {
            return { stdout: "b672416efadf\n" };
        }
        if (command === "docker network ls -q --filter label=com.docker.compose.project=static-page-test") {
            return { stdout: "9a1c\n" };
        }
        return { stdout: "" };
    });

    await composeStackAction(agent, "/opt/sc-apps/static-page-test", "compose.yaml", "static-page-test", "down");

    expect(ran).toContain("docker rm -f b672416efadf");
    expect(ran).toContain("docker network rm 9a1c");
    expect(ran.some((c) => c.includes("docker compose"))).toBe(false);
});

test("down on a present directory still goes through compose", async () => {
    const ran: string[] = [];
    const agent = fakeAgent((command) => {
        ran.push(command);
        return { stdout: "" };
    });

    await composeStackAction(agent, "/opt/sc-apps/static-page-test", "compose.yaml", "static-page-test", "down");

    expect(ran).toContain("docker compose -f compose.yaml -p static-page-test down");
    expect(ran.some((c) => c.startsWith("docker rm"))).toBe(false);
});
