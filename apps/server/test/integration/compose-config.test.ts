import { expect, test } from "bun:test";
import { composeConfig, getComposeStackStatus } from "../../src/features/docker/docker";
import type { HostAgent } from "../../src/host-agent";

// `docker compose config --format json` is asked for, but some compose builds
// print the canonical YAML instead — which used to leave every App looking
// empty (no services declared, so the status badge said "down" even with
// containers running). Both output shapes have to work.

/** A HostAgent stand-in that replays canned exec output — no docker, no fleet. */
function fakeAgent(reply: (command: string) => { stdout: string; stderr?: string; code?: number }): HostAgent {
    return {
        exec: async (command: string) => {
            const res = reply(command);
            return { stdout: res.stdout, stderr: res.stderr ?? "", code: res.code ?? 0 };
        },
    } as unknown as HostAgent;
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

// ---- status when the stack's directory is gone ------------------------------
//
// Every compose command runs as `cd <dir> && docker compose …`, so all of them
// fail at `cd` once that directory disappears — which says nothing about whether
// the containers are still up, and they usually are (folder deleted out from
// under a live stack, unmounted volume). The compose labels on the containers
// survive, so status falls back to plain `docker ps` filtered by project.

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
    const agent = fakeAgent((command) => {
        // Both compose invocations die at `cd` — that's what a missing dir does.
        if (command.startsWith("cd ")) {
            return { stdout: "", stderr: "no such file or directory", code: 1 };
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
    const agent = fakeAgent((command) => {
        if (command.startsWith("cd ")) {
            return { stdout: "", stderr: "no such file or directory", code: 1 };
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
