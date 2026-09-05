import * as path from "node:path";
import type { ApiEvent, ApiHandlers, CentralApiOperations } from "@central/shared";
import { API_PREFIX, MAX_UPLOAD_BYTES, userCan } from "@central/shared";
import { DEFAULT_FORWARDED_HEADER, headerForPeer, parseTrustedProxies, parseTrustedProxiesEnv, resolveClientIp, type TrustedProxyEntry } from "./client-ip";
import { corsHeaders as buildCorsHeaders, originAllowsRequest, resolveAllowedOrigins } from "./cors";
import { ComposeStackStore } from "./features/compose/store";
import { createComposeStacksFeature } from "./features/compose/feature";
import { createAuthFeature } from "./features/auth/feature";
import { CONFIG_DIR, readConfig } from "./config";
import { RoleStore } from "./roles";
import { createDebugFeature } from "./features/debug/feature";
import { createDockerFeature } from "./features/docker/feature";
import { composeApiHandlers, composeHttpRoutes, composeTaskHandlers, defineFeatures, flattenApiHandlers, matchHttpRoute } from "./feature";
import { createFilesFeature } from "./features/files/feature";
import { sweepTempFilesIn } from "./fs-atomic";
import { AuthStore } from "./auth";
import { Fleet } from "./fleet";
import { createNetworkFeature } from "./features/network/feature";
import { OidcStore } from "./features/oidc/store";
import { createOidcFeature } from "./features/oidc/feature";
import { createProcessesFeature } from "./features/processes/feature";
import { ProxyManager } from "./features/proxy/manager";
import { DashboardStore } from "./features/dashboard/store";
import { createDashboardFeature } from "./features/dashboard/feature";
import { ProxyStore } from "./features/proxy/store";
import { createProxyFeature } from "./features/proxy/feature";
import { createServersFeature } from "./features/servers/feature";
import { createSettingsFeature } from "./features/settings/feature";
import { createSystemdFeature } from "./features/systemd/feature";
import { createSystemUsersFeature } from "./features/system-users/feature";
import { TaskStore } from "./tasks/store";
import { TaskRunner } from "./tasks/runner";
import type { TaskHandlers } from "./tasks/types";
import { createTasksFeature } from "./features/tasks/feature";
import { createTerminalFeature } from "./features/terminal/feature";
import { ensureTls, localIps } from "./tls";
import { discoverWanIp } from "./stun";
import { startNodeServer } from "./node-server";
import { runAgentCli } from "./agent/agent-cli";
import { serveStatic } from "./static";
import { handleRpc, isRpcPath } from "./http/rpc";
import { EventHub, type WsData } from "./http/ws";
import { offerInteractiveInstall, runServerInstallCli } from "./server-install";
import { createZfsFeature } from "./features/zfs/feature";

// This single binary is both the control plane and the host agent. With
// `--agent` it connects to a control plane and runs the managed-host logic
// (never returns); otherwise it falls through and boots the control plane below.
const cliArgs = process.argv.slice(2);
if (cliArgs.includes("--agent")) {
    await runAgentCli(cliArgs);
    process.exit(0);
}

// Self-install as a supervised control-plane service. `--install-server` is the
// scripted path; running the bare binary on a TTY offers the same interactively.
// The installed systemd unit runs with no TTY, so it skips both and boots below.
if (cliArgs.includes("--install-server")) {
    await runServerInstallCli(cliArgs);
    process.exit(0);
}
if (cliArgs.length === 0 && process.stdin.isTTY && await offerInteractiveInstall()) {
    process.exit(0);
}

// The event hub owns the `/events` socket set; it can't be built until the fleet
// and task store exist, so `broadcast` delegates through this binding. Nothing
// can be pushed before boot finishes anyway — there are no subscribers yet.
let hub: EventHub | undefined;

function broadcast(event: ApiEvent): void {
    hub?.broadcast(event);
}

// Clear temp files abandoned by a previous run that was killed between write and
// rename (a crash, a self-update, power loss). Nothing in the data dir is in use
// yet, and only files older than the sweeper's grace period are touched, so this
// is safe even if another instance happens to share the directory.
await sweepTempFilesIn([CONFIG_DIR, path.join(CONFIG_DIR, "agent-binaries")], "cleanup");

const fleet = new Fleet(
    (serverId, snapshot) => broadcast({ kind: "metrics", data: { serverId, snapshot } }),
    (servers) => broadcast({ kind: "serversUpdate", data: servers }),
);
await fleet.init();

// Roles load first: computing a user's effective permissions resolves their role
// ids, and that happens on every authenticated request.
const roleStore = new RoleStore();
await roleStore.init();

const auth = new AuthStore(roleStore);
await auth.init();

const stackStore = new ComposeStackStore(fleet);

const wanIp = await discoverWanIp();
if (wanIp) {
    console.log(`Discovered WAN IP: ${wanIp}`);
}

// Leaf cert covers the addresses agents actually connect to (LAN, WAN, domain);
// the CA underneath it is the agents' stable trust anchor.
const tlsDir = path.join(CONFIG_DIR, "tls");
const startupConfig = await readConfig();
const tls = await ensureTls(tlsDir, { domain: startupConfig.domain ?? null, wanIp, lanIps: localIps() });

const nodeServer = await startNodeServer(
    fleet,
    tls,
    wanIp,
    (serverId, snapshot) => broadcast({ kind: "metrics", data: { serverId, snapshot } }),
    tlsDir,
);

/**
 * Proxies whose forwarded header we believe, and the header each one writes.
 *
 * Editable from Settings and applied live, like the CORS allowlist — but the
 * environment wins outright when set, and `trustedProxiesLocked` tells the UI to
 * present it read-only rather than accepting a save the env would override.
 */
const envTrustedProxies = process.env.SC_TRUSTED_PROXIES
    ? parseTrustedProxiesEnv(process.env.SC_TRUSTED_PROXIES)
    : null;
export const trustedProxiesLocked = envTrustedProxies !== null;

/** Header used for a proxy whose entry doesn't name one of its own. */
const forwardedHeader = (process.env.SC_FORWARDED_HEADER || startupConfig.forwardedHeader || DEFAULT_FORWARDED_HEADER).trim().toLowerCase();

let trustedProxies = parseTrustedProxies([]);

function applyTrustedProxies(configured: TrustedProxyEntry[]): void {
    trustedProxies = parseTrustedProxies(envTrustedProxies ?? configured);
    console.log(trustedProxies.length > 0
        ? `Trusting forwarded headers from ${trustedProxies.length} configured proxy range(s); default header ${forwardedHeader}`
        : "Not trusting any forwarded headers (client IP is the direct peer)");
}
applyTrustedProxies(startupConfig.trustedProxies ?? []);

const oidcStore = new OidcStore();
const dashboardStore = new DashboardStore();
const proxyStore = new ProxyStore();
const proxyManager = new ProxyManager(fleet, proxyStore);

// ---- Features -------------------------------------------------------------------
//
// Two batches, for one ordering reason: features own the task kinds, so their
// registry has to exist before the TaskRunner that dispatches them, while the
// `tasks` feature *takes* that runner and so must come after it. It is the only
// feature in the second batch. Boot order stays this explicit, hand-written
// sequence rather than a resolved dependency graph — see
// doc/idea_feature_convention.md §4.
//
// Both registries go through `defineFeatures` rather than being plain arrays, so
// each element keeps its declared operations and task kinds — that's what the
// compose* helpers union to prove the protocol is fully covered.
const baseFeatures = defineFeatures(
    createComposeStacksFeature(stackStore, fleet),
    createDockerFeature(fleet, stackStore),
    createZfsFeature(fleet),
    createSystemdFeature(fleet),
    createSystemUsersFeature(fleet, auth),
    createFilesFeature(fleet),
    createProcessesFeature(fleet),
    createNetworkFeature(fleet),
    createTerminalFeature(),
    createDebugFeature(),
    createAuthFeature(auth, roleStore),
    createOidcFeature(oidcStore, auth),
    createDashboardFeature(dashboardStore),
    createProxyFeature(proxyManager, proxyStore),
    createServersFeature(fleet, nodeServer),
    createSettingsFeature(nodeServer, oidcStore, applyAllowedOrigins, applyTrustedProxies, trustedProxiesLocked),
);

const taskStore = new TaskStore();
await taskStore.init();

hub = new EventHub(fleet, taskStore);

// Typed as the full `TaskHandlers`, so a new kind in the `TaskSpec` union won't
// compile until some feature handles it — the guarantee this composition exists for.
const allTaskHandlers: TaskHandlers = composeTaskHandlers(baseFeatures);
const taskRunner = new TaskRunner(
    taskStore,
    fleet,
    (run) => broadcast({ kind: "taskUpdate", data: run }),
    (taskId, line) => broadcast({ kind: "taskLog", data: { taskId, lines: [line] } }),
    allTaskHandlers,
);

const features = defineFeatures(...baseFeatures, createTasksFeature(taskRunner, taskStore));
for (const f of features) await f.init?.({ configDir: CONFIG_DIR, broadcast });

// Same completeness check on the API side: this assignment is what fails, naming
// the missing `handle*` methods, if an operation in `CentralApiOperations` has no
// feature claiming it.
const handler: ApiHandlers<CentralApiOperations> = composeApiHandlers(features);

// One flat `Map` keyed by `"<namespace>/<operation>"` — the dispatcher's whole
// routing table, and the only thing a request path can resolve against.
const apiTable = flattenApiHandlers(handler);

// Raw (non-RPC) endpoints features own — OIDC's discovery/JWKS/token/userinfo
// today. Matched before the RPC prefix and before static assets.
const httpRoutes = composeHttpRoutes(features);



/**
 * Origins allowed to read API responses cross-origin.
 *
 * Unlike bindHost/trustedProxies above this is *not* frozen at startup: it's
 * editable from Settings, and a control that only takes effect after a restart is
 * a control that looks broken. `applyAllowedOrigins` is handed to the settings
 * feature, which calls it after persisting.
 *
 * `SC_ALLOWED_ORIGINS` still wins when set — an install configured by unit file or
 * container env shouldn't have that quietly overwritten from the web UI.
 */
const envAllowedOrigins = process.env.SC_ALLOWED_ORIGINS?.split(",");
let allowedOrigins: string[] = [];

function applyAllowedOrigins(configured: string[], primaryUrl: string | null): void {
    allowedOrigins = resolveAllowedOrigins(envAllowedOrigins ?? configured, primaryUrl);
    console.log(allowedOrigins.length > 0
        ? `CORS restricted to: ${allowedOrigins.join(", ")}`
        : "CORS: allowing any origin (no allowed origins configured)");
}
applyAllowedOrigins(startupConfig.allowedOrigins ?? [], startupConfig.primaryUrl ?? null);

/** `Access-Control-*` headers for this request — see cors.ts. */
function corsFor(req: Request): Record<string, string> {
    return buildCorsHeaders(req.headers.get("origin"), allowedOrigins);
}

/**
 * Whether this request's `Origin` lets us act on it — see cors.ts. CORS headers
 * only decide who may *read* a reply; this is what stops a cross-origin page
 * getting a state-changing call through in the first place.
 *
 * The hosts it may claim to be are the `Host` it arrived on plus any
 * `X-Forwarded-Host` a front end wrote (comma-separated when several did).
 */
function originAllowed(req: Request): boolean {
    const forwarded = (req.headers.get("x-forwarded-host") ?? "").split(",");
    return originAllowsRequest(req.headers.get("origin"), [req.headers.get("host"), ...forwarded], allowedOrigins);
}

/** The address to attribute a request to — see client-ip.ts. The header is chosen
 *  per peer, so two front ends writing different headers both resolve correctly. */
function clientIp(req: Request, serverCtx: { requestIP(req: Request): { address: string } | null }): string | null {
    const peer = serverCtx.requestIP(req)?.address ?? null;
    const header = headerForPeer(peer, trustedProxies, forwardedHeader);
    return resolveClientIp(peer, req.headers.get(header), trustedProxies, header);
}


// ---- HTTP / WebSocket ----------------------------------------------------------

// uploadFile ships the file as base64 (~4/3 the raw size) inside a JSON body, so the
// HTTP body cap has to clear MAX_UPLOAD_BYTES by more than Bun's ~128MB default before
// the request even reaches the handler to enforce the real limit itself.
const MAX_REQUEST_BODY_BYTES = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 16 * 1024 * 1024;

// Unset binds every interface. Behind a TLS-terminating proxy on the same host,
// setting this to 127.0.0.1 keeps the plaintext port off the network entirely.
const bindHost = process.env.SC_BIND || startupConfig.bindHost;

const server = Bun.serve<WsData>({
    port: Number(process.env.PORT) || 4141,
    ...(bindHost ? { hostname: bindHost } : {}),
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    async fetch(req, serverCtx) {
        const url = new URL(req.url);
        const corsHeaders = corsFor(req);

        if (req.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        const route = matchHttpRoute(httpRoutes, req.method, url.pathname);
        if (route) {
            return route.handle(req, corsHeaders);
        }

        // WebSocket channels carry the bearer token as a query param, since
        // browsers can't set Authorization headers on WS upgrades.
        if (url.pathname === `${API_PREFIX}/events` || url.pathname === `${API_PREFIX}/terminal`) {
            const user = await auth.authenticate(url.searchParams.get("token"));
            if (!user) {
                return new Response("Unauthorized", { status: 401, headers: corsHeaders });
            }
            // The terminal isn't an RPC operation, so it can't declare a node on a
            // feature — it's gated here instead. `panel.terminal` is sensitive, so
            // no wildcard reaches it; the host-user mapping check in
            // openTerminalShell still applies on top of this.
            if (url.pathname === `${API_PREFIX}/terminal` && !userCan(user, "panel.terminal")) {
                return new Response("Forbidden", { status: 403, headers: corsHeaders });
            }

            if (url.pathname === `${API_PREFIX}/events`) {
                if (serverCtx.upgrade(req, { data: { channel: "events", user } satisfies WsData })) {
                    return undefined as unknown as Response;
                }
                return new Response("Upgrade failed", { status: 400, headers: corsHeaders });
            }
            const serverId = url.searchParams.get("serverId");
            if (!serverId) {
                return Response.json({ error: "serverId required" }, { status: 400, headers: corsHeaders });
            }
            const containerId = url.searchParams.get("containerId");
            const data: WsData = { channel: "terminal", serverId, containerId, user, shell: null };
            if (serverCtx.upgrade(req, { data })) {
                return undefined as unknown as Response;
            }
            return new Response("Upgrade failed", { status: 400, headers: corsHeaders });
        }

        if (isRpcPath(url.pathname)) {
            return handleRpc(req, url, corsHeaders, {
                table: apiTable,
                auth,
                originAllowed,
                clientIp: (r) => clientIp(r, serverCtx),
            });
        }

        // Serve the embedded SPA for browser GETs. Returns null in dev (UI comes from
        // Vite), so we fall through to the 404 below.
        if (req.method === "GET" || req.method === "HEAD") {
            const asset = serveStatic(url.pathname);
            if (asset) {
                return asset;
            }
        }

        return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
    },
    websocket: hub.handler(),
});

console.log(`Server Central backend running at http://${bindHost ?? "localhost"}:${server.port}`);
