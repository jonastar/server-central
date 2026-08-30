import * as path from "node:path";
import type { ServerWebSocket } from "bun";
import type { ApiEvent, ApiHandlerPrefixed, CentralApiOperations, OpRequirement, TerminalClientMessage, TerminalServerMessage, UserInfo } from "@central/shared";
import { API_PREFIX, MAX_UPLOAD_BYTES, OP_REQUIREMENTS, eventPermission, userCan } from "@central/shared";
import { DEFAULT_FORWARDED_HEADER, headerForPeer, parseTrustedProxies, parseTrustedProxiesEnv, resolveClientIp, type TrustedProxyEntry } from "./client-ip";
import { corsHeaders as buildCorsHeaders, originAllowsRequest, resolveAllowedOrigins } from "./cors";
import type { ShellSession } from "./host-agent";
import { ComposeStackStore } from "./features/compose/store";
import { createComposeStacksFeature } from "./features/compose/feature";
import { createAuthFeature } from "./features/auth/feature";
import { CONFIG_DIR, readConfig } from "./config";
import { RoleStore } from "./roles";
import { createDebugFeature } from "./features/debug/feature";
import { createDockerFeature } from "./features/docker/feature";
import { composeApiHandlers, composeTaskHandlers, defineFeatures } from "./feature";
import { createFilesFeature } from "./features/files/feature";
import { sweepTempFilesIn } from "./fs-atomic";
import { AuthStore, type AuthContext } from "./auth";
import { Fleet } from "./fleet";
import { createNetworkFeature } from "./features/network/feature";
import { OidcStore } from "./features/oidc/store";
import { createOidcFeature } from "./features/oidc/feature";
import { discoveryDocument } from "./features/oidc/discovery";
import { ACCESS_TOKEN_TTL_S, buildAccessToken, buildIdToken, jwks, verifyJwt, verifyPkce } from "./features/oidc/tokens";
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
import { taskHandlers, type TaskHandlers } from "./tasks/types";
import { createTasksFeature } from "./features/tasks/feature";
import { openTerminalShell, createTerminalFeature } from "./features/terminal/feature";
import { ensureTls, localIps } from "./tls";
import { discoverWanIp } from "./stun";
import { startNodeServer } from "./node-server";
import { runAgentCli } from "./agent/agent-cli";
import { serveStatic } from "./static";
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

type Command = keyof CentralApiOperations;

type WsData =
    // The user rides along so pushed events can be filtered the same way pulled
    // ones are: this socket carries fleet inventory and task history, which are
    // exactly the `getServers`/`listTasks` payloads by another route. Resolved at
    // upgrade and not refreshed, so a permission change takes effect on the
    // client's next reconnect rather than mid-stream.
    | { channel: "events"; user: UserInfo }
    // containerId, when set, opens a terminal into that container (`docker exec
    // -it`) instead of a host shell — see openTerminal().
    | { channel: "terminal"; serverId: string; containerId: string | null; user: UserInfo; shell: ShellSession | null };

const eventSockets = new Set<ServerWebSocket<WsData>>();

function broadcast(event: ApiEvent): void {
    const payload = JSON.stringify(event);
    const required = eventPermission(event.kind);
    for (const socket of eventSockets) {
        if (!userCan(socket.data.user, required)) {
            continue;
        }
        socket.send(payload);
    }
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

// ---- Features -------------------------------------------------------------------
//
// Two batches, for one ordering reason: host features own every task kind, so
// their registry has to exist before the TaskRunner that dispatches it, while the
// control-plane features below include the tasks feature itself and so must come
// after the runner. Boot order stays this explicit, hand-written sequence rather
// than a resolved dependency graph — see doc/idea_feature_convention.md §4.
//
// Both registries go through `defineFeatures` rather than being plain arrays, so
// each element keeps its declared operations and task kinds — that's what the
// compose* helpers union to prove the protocol is fully covered.
const hostFeatures = defineFeatures(
    createComposeStacksFeature(stackStore, fleet),
    createDockerFeature(fleet),
    createZfsFeature(fleet),
    createSystemdFeature(fleet),
    createSystemUsersFeature(fleet, auth),
    createFilesFeature(fleet),
    createProcessesFeature(fleet),
    createNetworkFeature(fleet),
    createTerminalFeature(),
    createDebugFeature(),
);

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

const taskStore = new TaskStore();
await taskStore.init();

// Typed as the full `TaskHandlers`, so a new kind in the `TaskSpec` union won't
// compile until some feature (or the cross-cutting set in tasks/types.ts) handles
// it — the guarantee this composition exists for.
const featureTasks = composeTaskHandlers(hostFeatures);
const allTaskHandlers: TaskHandlers = { ...taskHandlers, ...featureTasks.handlers };
const taskRunner = new TaskRunner(
    taskStore,
    fleet,
    stackStore,
    (run) => broadcast({ kind: "taskUpdate", data: run }),
    (taskId, line) => broadcast({ kind: "taskLog", data: { taskId, lines: [line] } }),
    allTaskHandlers,
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

const features = defineFeatures(
    ...hostFeatures,
    createAuthFeature(auth, roleStore),
    createOidcFeature(oidcStore),
    createDashboardFeature(dashboardStore),
    createProxyFeature(proxyManager, proxyStore),
    createServersFeature(fleet, nodeServer),
    createSettingsFeature(nodeServer, oidcStore, applyAllowedOrigins, applyTrustedProxies, trustedProxiesLocked),
    createTasksFeature(taskRunner, taskStore),
);
for (const f of features) await f.init?.({ configDir: CONFIG_DIR, broadcast });

// Same completeness check on the API side: this assignment is what fails, naming
// the missing `handle*` methods, if an operation in `CentralApiOperations` has no
// feature claiming it.
const handler: ApiHandlerPrefixed<CentralApiOperations> = composeApiHandlers(features);



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

function bearerToken(req: Request): string | null {
    const header = req.headers.get("Authorization");
    if (!header) {
        return null;
    }
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1] : null;
}

// ---- OIDC token endpoint -------------------------------------------------------
//
// Unlike every other route, this is called by the relying party's backend, not
// the browser — so it's `application/x-www-form-urlencoded` per the OIDC spec,
// not our usual JSON-RPC shape, and the client authenticates with its own
// credential (client_secret_post or HTTP Basic / client_secret_basic) instead of
// a session bearer token.

function clientCredentials(req: Request, body: URLSearchParams): { clientId: string; clientSecret: string } | null {
    const basic = req.headers.get("Authorization");
    if (basic?.startsWith("Basic ")) {
        const decoded = Buffer.from(basic.slice(6), "base64").toString("utf8");
        const sep = decoded.indexOf(":");
        if (sep !== -1) {
            return { clientId: decoded.slice(0, sep), clientSecret: decoded.slice(sep + 1) };
        }
    }
    const clientId = body.get("client_id");
    const clientSecret = body.get("client_secret");
    return clientId && clientSecret ? { clientId, clientSecret } : null;
}

async function handleOidcToken(req: Request): Promise<Response> {
    const corsHeaders = corsFor(req);
    const body = new URLSearchParams(await req.text());
    if (body.get("grant_type") !== "authorization_code") {
        return Response.json({ error: "unsupported_grant_type" }, { status: 400, headers: corsHeaders });
    }
    const code = body.get("code");
    const redirectUri = body.get("redirect_uri");
    const codeVerifier = body.get("code_verifier");
    const creds = clientCredentials(req, body);
    if (!code || !redirectUri || !codeVerifier || !creds) {
        return Response.json({ error: "invalid_request" }, { status: 400, headers: corsHeaders });
    }

    const client = await oidcStore.verifyClientSecret(creds.clientId, creds.clientSecret);
    if (!client) {
        return Response.json({ error: "invalid_client" }, { status: 401, headers: corsHeaders });
    }
    const grant = oidcStore.consumeCode(code);
    if (!grant || grant.clientId !== client.id || grant.redirectUri !== redirectUri) {
        return Response.json({ error: "invalid_grant" }, { status: 400, headers: corsHeaders });
    }
    if (!verifyPkce(codeVerifier, grant.codeChallenge)) {
        return Response.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, { status: 400, headers: corsHeaders });
    }
    const user = auth.getUserById(grant.userId);
    if (!user) {
        return Response.json({ error: "invalid_grant", error_description: "User no longer exists" }, { status: 400, headers: corsHeaders });
    }
    const config = await readConfig();
    if (!config.primaryUrl) {
        return Response.json({ error: "server_error", error_description: "Primary URL is not configured" }, { status: 500, headers: corsHeaders });
    }

    const key = oidcStore.key;
    const idToken = buildIdToken(user, { issuer: config.primaryUrl, clientId: client.id, nonce: grant.nonce, authTime: Math.floor(grant.issuedAt / 1000) }, key);
    const accessToken = buildAccessToken(user, { issuer: config.primaryUrl, clientId: client.id, scope: grant.scope }, key);
    return Response.json({
        access_token: accessToken,
        id_token: idToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_S,
        scope: grant.scope,
    }, { headers: corsHeaders });
}

// ---- Terminal bridge ---------------------------------------------------------

function sendTerminal(ws: ServerWebSocket<WsData>, msg: TerminalServerMessage): void {
    ws.send(JSON.stringify(msg));
}

async function openTerminal(ws: ServerWebSocket<WsData>): Promise<void> {
    if (ws.data.channel !== "terminal") {
        return;
    }
    try {
        const shell = await openTerminalShell(fleet, ws.data.serverId, ws.data.containerId, ws.data.user);
        ws.data.shell = shell;
        shell.onData((data) => sendTerminal(ws, { type: "data", data }));
        shell.onExit((code) => {
            sendTerminal(ws, { type: "exit", code });
            ws.close();
        });
    } catch (err) {
        sendTerminal(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
        ws.close();
    }
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

        // ---- OIDC: public discovery/JWKS + the raw (non-RPC) token/userinfo routes.
        // GET /oidc/authorize needs no special-casing here — it's a plain browser
        // navigation with no extension, so it already falls through to serveStatic's
        // SPA-shell fallback below; the React app itself recognizes the path.
        if (url.pathname === "/.well-known/openid-configuration" || url.pathname === "/.well-known/jwks.json") {
            const config = await readConfig();
            if (!config.primaryUrl) {
                return Response.json({ error: "Primary URL is not configured" }, { status: 404, headers: corsHeaders });
            }
            const body = url.pathname === "/.well-known/jwks.json" ? jwks(oidcStore.key) : discoveryDocument(config.primaryUrl);
            return Response.json(body, { headers: corsHeaders });
        }

        if (url.pathname === "/oidc/token" && req.method === "POST") {
            return handleOidcToken(req);
        }

        if (url.pathname === "/oidc/userinfo") {
            const token = bearerToken(req);
            const payload = token ? verifyJwt(token, oidcStore.key.publicKeyPem) : null;
            const sub = payload && typeof payload.sub === "string" ? payload.sub : null;
            const user = sub ? auth.getUserById(sub) : null;
            if (!user) {
                return Response.json({ error: "invalid_token" }, { status: 401, headers: corsHeaders });
            }
            return Response.json({ sub: user.id, preferred_username: user.username, groups: user.permissions.filter((p) => p.startsWith("app.")) }, { headers: corsHeaders });
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

        // Everything under /api/ is the JSON-RPC surface. It's matched before the
        // static handler and never falls through to it, so an unknown command reads
        // as a 404 to the caller instead of being answered with the SPA shell.
        if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
            if (req.method !== "POST") {
                return Response.json({ error: "Use POST" }, { status: 405, headers: corsHeaders });
            }
            // Every command here changes state or hands out a session, and a
            // "simple" cross-origin POST reaches this point without a preflight —
            // including the unauthenticated PUBLIC_COMMANDS below. Refuse a
            // foreign origin before that, not just in the response headers.
            if (!originAllowed(req)) {
                return Response.json({ error: "Cross-origin request refused" }, { status: 403, headers: corsHeaders });
            }

            const command = url.pathname.slice(API_PREFIX.length + 1) as Command;
            // Dispatch only ever reaches `handle*` methods — never an arbitrary property
            // off the handler (constructor, toString, …) — by prefixing the derived name.
            const method = `handle${command.charAt(0).toUpperCase()}${command.slice(1)}` as keyof ApiHandlerPrefixed<CentralApiOperations>;
            const fn = (handler[method] as ((data: unknown, ctx: AuthContext) => Promise<unknown>) | undefined)?.bind(handler);
            if (!fn) {
                return Response.json({ error: `Unknown command: ${command}` }, { status: 404, headers: corsHeaders });
            }

            const token = bearerToken(req);
            const user = await auth.authenticate(token);

            // One gate for every operation. `fn` above proves the command exists;
            // this proves the caller may run it. Order matters: no session is a
            // 401 (the client should log in and retry), a session without the
            // node is a 403 (retrying will never help).
            // Fail closed on anything not explicitly classified. Startup asserts
            // this can't happen; the check stays because the cost of being wrong
            // here is an open endpoint, and `undefined` would otherwise fall
            // through to the permission comparison below.
            const required: OpRequirement | undefined = OP_REQUIREMENTS[command];
            if (required === undefined) {
                return Response.json({ error: "Forbidden" }, { status: 403, headers: corsHeaders });
            }
            if (required !== "public") {
                if (!user) {
                    return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
                }
                if (required !== "authenticated" && !userCan(user, required)) {
                    return Response.json({ error: `Requires the "${required}" permission` }, { status: 403, headers: corsHeaders });
                }
            }

            const ip = clientIp(req, serverCtx);
            const userAgent = req.headers.get("user-agent");
            const data = await req.json().catch(() => null);
            try {
                const result = await fn(data ?? undefined, { token, user, ip, userAgent });
                return new Response(result === undefined ? "null" : JSON.stringify(result), {
                    headers: { ...corsHeaders, "Content-Type": "application/json" },
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : "Unexpected server error";
                return Response.json({ error: message }, { status: 500, headers: corsHeaders });
            }
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
    websocket: {
        open(ws) {
            if (ws.data.channel === "events") {
                eventSockets.add(ws);
                // Same filter as broadcast, applied to the snapshot. The two
                // halves are independent permissions on purpose: reading task
                // history and reading the fleet are separate grants everywhere
                // else, and this is the one place they'd otherwise be bundled.
                const canSeeServers = userCan(ws.data.user, "panel.servers.read");
                ws.send(JSON.stringify({
                    kind: "init",
                    data: {
                        servers: canSeeServers ? fleet.entries() : [],
                        metricsHistory: canSeeServers ? fleet.metricsHistory() : {},
                        tasks: userCan(ws.data.user, "panel.tasks.read") ? taskStore.list() : [],
                    },
                } satisfies ApiEvent));
            } else {
                void openTerminal(ws);
            }
        },
        message(ws, message) {
            if (ws.data.channel !== "terminal" || !ws.data.shell) {
                return;
            }
            try {
                const msg = JSON.parse(String(message)) as TerminalClientMessage;
                if (msg.type === "input") {
                    ws.data.shell.write(msg.data);
                }
                else if (msg.type === "resize") {
                    ws.data.shell.resize(msg.cols, msg.rows);
                }
            } catch { /* ignore malformed frames */ }
        },
        close(ws) {
            if (ws.data.channel === "events") {
                eventSockets.delete(ws);
            }
            else {
                ws.data.shell?.close();
            }
        },
    },
});

console.log(`Server Central backend running at http://${bindHost ?? "localhost"}:${server.port}`);
