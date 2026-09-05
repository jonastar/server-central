import type { ApiOperation, OpRequirement, UserInfo } from "@central/shared";
import { API_PREFIX, OP_REQUIREMENTS, userCan } from "@central/shared";
import type { AuthStore, AuthContext } from "../auth";

// ---- The JSON-RPC surface -------------------------------------------------------
//
// Everything under `/api/` is one shape: `POST /api/<operation>` with a JSON body,
// answered by the composed handler map. This module owns the dispatch and the
// authorization gate in front of it — the one place every operation passes
// through, and the reason it's a module rather than a closure in the composition
// root: it's the security boundary, and it should be reachable by a test without
// standing up `Bun.serve`.

/** The qualified `"<namespace>/<operation>"` wire name — exactly the path under
 *  {@link API_PREFIX}, so the URL and the permission key are the same string. */
export type Command = ApiOperation;

/** The dispatch table: qualified name -> handler. Built once at boot by
 *  `flattenApiHandlers`. */
export type ApiTable = Map<string, (data: unknown, ctx: AuthContext) => Promise<unknown>>;

/** Everything the dispatcher needs from the surrounding server. */
export interface RpcDeps {
    table: ApiTable;
    auth: AuthStore;
    /** Whether this request's `Origin` lets us act on it at all — see cors.ts. */
    originAllowed(req: Request): boolean;
    /** Address to attribute the call to, already resolved through any trusted proxy. */
    clientIp(req: Request): string | null;
}

export function bearerToken(req: Request): string | null {
    const header = req.headers.get("Authorization");
    if (!header) {
        return null;
    }
    const match = /^Bearer\s+(.+)$/i.exec(header);
    return match ? match[1] : null;
}

/** Whether a path belongs to the RPC surface. Matched before static assets so an
 *  unknown command reads as a 404 rather than being answered with the SPA shell. */
export function isRpcPath(pathname: string): boolean {
    return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

/**
 * Resolve a caller's right to run an operation.
 *
 * Order matters: no session is a 401 (the client should log in and retry), a
 * session without the node is a 403 (retrying will never help). Anything not
 * explicitly classified fails closed — startup asserts that can't happen, but the
 * check stays because the cost of being wrong here is an open endpoint, and
 * `undefined` would otherwise fall through to the permission comparison.
 */
export function authorize(command: Command, user: UserInfo | null): { ok: true } | { ok: false; status: number; error: string } {
    const required: OpRequirement | undefined = OP_REQUIREMENTS[command];
    if (required === undefined) {
        return { ok: false, status: 403, error: "Forbidden" };
    }
    if (required === "public") {
        return { ok: true };
    }
    if (!user) {
        return { ok: false, status: 401, error: "Unauthorized" };
    }
    if (required !== "authenticated" && !userCan(user, required)) {
        return { ok: false, status: 403, error: `Requires the "${required}" permission` };
    }
    return { ok: true };
}

export async function handleRpc(req: Request, url: URL, cors: Record<string, string>, deps: RpcDeps): Promise<Response> {
    if (req.method !== "POST") {
        return Response.json({ error: "Use POST" }, { status: 405, headers: cors });
    }
    // Every command here changes state or hands out a session, and a "simple"
    // cross-origin POST reaches this point without a preflight — including the
    // unauthenticated public ones. Refuse a foreign origin before that, not just
    // in the response headers.
    if (!deps.originAllowed(req)) {
        return Response.json({ error: "Cross-origin request refused" }, { status: 403, headers: cors });
    }

    // `<namespace>/<operation>`, both segments straight off the request path and
    // both untrusted. Neither is used to index an object: the table is a `Map`,
    // so a path like `constructor/x` simply misses. Everything below this point
    // is therefore a registered operation — which is what makes the
    // `OP_REQUIREMENTS` object lookup in `authorize` safe.
    const command = url.pathname.slice(API_PREFIX.length + 1);
    const fn = deps.table.get(command);
    if (!fn) {
        return Response.json({ error: `Unknown command: ${command}` }, { status: 404, headers: cors });
    }

    const token = bearerToken(req);
    const user = await deps.auth.authenticate(token);

    // `fn` above proves the command exists; this proves the caller may run it.
    const verdict = authorize(command as Command, user);
    if (!verdict.ok) {
        return Response.json({ error: verdict.error }, { status: verdict.status, headers: cors });
    }

    const ip = deps.clientIp(req);
    const userAgent = req.headers.get("user-agent");
    const data = await req.json().catch(() => null);
    try {
        const result = await fn(data ?? undefined, { token, user, ip, userAgent });
        return new Response(result === undefined ? "null" : JSON.stringify(result), {
            headers: { ...cors, "Content-Type": "application/json" },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Unexpected server error";
        return Response.json({ error: message }, { status: 500, headers: cors });
    }
}
