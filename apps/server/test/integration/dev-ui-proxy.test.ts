import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * `serveDevUi` is what makes dev the same shape as production: one origin, with
 * the control plane forwarding anything it doesn't own to the Vite dev server.
 *
 * The target is read per request rather than at import, so a test can point it
 * somewhere else — including at nothing, for the offline case.
 */
describe("dev UI proxy", () => {
    let vite: ReturnType<typeof Bun.serve>;
    let serveDevUi: (req: Request) => Promise<Response>;

    beforeAll(async () => {
        vite = Bun.serve({
            port: 0,
            fetch(req) {
                const url = new URL(req.url);
                if (url.pathname === "/echo-host") {
                    return new Response(req.headers.get("host") ?? "");
                }
                if (url.pathname === "/echo-accept-encoding") {
                    return new Response(req.headers.get("accept-encoding") ?? "(none)");
                }
                if (url.pathname === "/hop") {
                    // Genuinely gzipped, so fetch decompresses it — the header
                    // surviving onto our response is exactly the bug being
                    // guarded against, and a lie here would not reproduce it.
                    return new Response(Bun.gzipSync(Buffer.from("body")), {
                        headers: { "Content-Encoding": "gzip", "X-Keep": "yes" },
                    });
                }
                if (url.pathname === "/missing") {
                    return new Response("nope", { status: 404 });
                }
                return new Response(`<!doctype html><!-- ${url.pathname}${url.search} -->`, {
                    headers: { "Content-Type": "text/html" },
                });
            },
        });
        process.env.SC_DEV_UI_ORIGIN = `http://127.0.0.1:${vite.port}`;
        ({ serveDevUi } = await import("../../src/static"));
    });

    afterAll(() => vite.stop(true));

    test("forwards an SPA route, path and query intact", async () => {
        const res = await serveDevUi(new Request("http://control-plane.example/device?user_code=BDWD-HQPK"));
        expect(res.status).toBe(200);
        // The two client routes that used to 404 in dev, because the control
        // plane had no SPA to fall through to.
        expect(await res.text()).toContain("/device?user_code=BDWD-HQPK");
    });

    test("presents the dev server's own Host, not the one the browser used", async () => {
        // Vite refuses hosts it wasn't configured for, and the control plane is
        // reached as a tailnet name or a proxied domain. Rewriting the Host is
        // what keeps `allowedHosts` from becoming another list to maintain.
        const res = await serveDevUi(new Request("https://sc.home.example/echo-host"));
        expect(await res.text()).toBe(`127.0.0.1:${vite.port}`);
    });

    test("asks for the body uncompressed, overriding fetch's own default", async () => {
        // fetch would transparently decompress while `content-encoding: gzip`
        // survived onto our response, and the browser would gunzip plain text.
        const req = new Request("http://control-plane.example/echo-accept-encoding", { headers: { "Accept-Encoding": "gzip, br" } });
        // Deleting the header is not enough — fetch supplies `gzip, deflate,
        // br, zstd` of its own — so it has to be set, not removed.
        expect(await (await serveDevUi(req)).text()).toBe("identity");
    });

    test("drops hop-by-hop headers but keeps the rest", async () => {
        const res = await serveDevUi(new Request("http://control-plane.example/hop"));
        expect(res.headers.get("content-encoding")).toBeNull();
        expect(res.headers.get("transfer-encoding")).toBeNull();
        expect(res.headers.get("x-keep")).toBe("yes");
        expect(await res.text()).toBe("body");
    });

    test("passes the dev server's status through rather than inventing one", async () => {
        expect((await serveDevUi(new Request("http://control-plane.example/missing"))).status).toBe(404);
    });

    test("explains itself when the dev server isn't running", async () => {
        const restore = process.env.SC_DEV_UI_ORIGIN;
        // Port 1: nothing listens there, and the origin is read per request
        // rather than at import, so this needs no module juggling.
        process.env.SC_DEV_UI_ORIGIN = "http://127.0.0.1:1";
        const res = await serveDevUi(new Request("http://control-plane.example/"));
        process.env.SC_DEV_UI_ORIGIN = restore;
        expect(res.status).toBe(502);
        // A developer who forgot `dev:web` gets the fix, not a stack trace.
        expect(await res.text()).toContain("bun run dev:web");
    });
});
