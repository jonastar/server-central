import { expect, test } from "bun:test";
import { composeConfig, getAppStatus } from "../../src/features/docker/docker";
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

test("getAppStatus merges YAML-shaped config with compose ps", async () => {
    const status = await getAppStatus(
        fakeAgent((command) => command.includes(" ps ")
            ? { stdout: JSON.stringify({ Service: "db", Image: "postgres:16.2-alpine", State: "running" }) }
            : { stdout: YAML_OUTPUT }),
        "/opt/bl", "compose.yaml", "bl",
    );
    expect(status.services.map((s) => s.name)).toEqual(["db", "webapi"]);
    expect(status.status).toBe("partial");
});
