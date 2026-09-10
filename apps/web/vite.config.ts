import { defineConfig, mergeConfig, type ProxyOptions, type UserConfig } from "vite";
import { DEV_SERVER_API_PREFIXES } from "@central/shared";
import react from "@vitejs/plugin-react";

/** Set only by `bun run lab web`; absent for ordinary `bun run dev`. */
const LAB_API_PORT = process.env.VITE_API_PORT ? Number(process.env.VITE_API_PORT) : null;

const stripOrigin: NonNullable<ProxyOptions["configure"]> = (proxy) => {
    proxy.on("proxyReq", (proxyReq) => proxyReq.removeHeader("origin"));
};

/**
 * Forward the control plane's own paths to it, leaving everything else with Vite.
 *
 * The list comes from `@central/shared` rather than being written here, and a
 * server-side test asserts it covers every raw HTTP route the features register.
 * That guard exists because this list silently lost `/oidc/revoke` and
 * `/oidc/device_authorization`: an unlisted path is not a 404 here, it falls
 * through to the SPA shell, so a device asking for codes got 200 text/html back.
 */
function labProxy(port: number): Record<string, ProxyOptions> {
    const target = `http://127.0.0.1:${port}`;
    return Object.fromEntries(DEV_SERVER_API_PREFIXES.map((prefix) => [
        prefix,
        // `origin` is dropped along with the Host rewrite: the control plane
        // refuses a state-changing request whose Origin isn't the host it
        // arrived on (see cors.ts), and this proxy stands in for the single
        // origin a released build is served from. Leaving the dev server's own
        // origin on would make every call look foreign.
        //
        // Deliberately no `ws: true`: Vite 5 proxies through `http-proxy`, whose
        // websocket upgrade handling doesn't work under Bun — the upgrade
        // reaches the control plane and it answers 101, but nothing written back
        // is delivered, so the browser hangs in CONNECTING. api.ts sends sockets
        // straight to the control plane in this mode instead.
        { target, changeOrigin: true, configure: stripOrigin } satisfies ProxyOptions,
    ]));
}

const config: UserConfig = {
    plugins: [react()],
    server: {
        // SC_WEB_PORT lets a second dev server run alongside the usual one — the
        // e2e lab starts one on 5251 so it doesn't fight `bun run dev:web`.
        port: Number(process.env.SC_WEB_PORT) || 5151,
        // Normally you do NOT open this port. The control plane serves the UI in
        // dev too, forwarding here for anything it doesn't own (see the server's
        // static.ts `serveDevUi`), so dev has one origin exactly like a release
        // build does. HMR still needs to reach this server directly, and the page
        // is on another port, so the injected client is told where to look.
        hmr: { clientPort: Number(process.env.SC_WEB_PORT) || 5151 },
        // The exception, and the only reason a proxy still exists here: the e2e
        // lab's control plane is a release binary inside a container. It serves
        // its own embedded UI and cannot forward to a dev server on your laptop,
        // so for that one flow the dev server is the origin you open and it needs
        // the API. `bun run lab web` is what sets VITE_API_PORT.
        ...(LAB_API_PORT ? { proxy: labProxy(LAB_API_PORT) } : {}),
    },
};

export default defineConfig(async () => {
    // Optional gitignored per-machine override (e.g. server.host/allowedHosts for
    // tailnet access) — copy vite.config.local.example.ts to vite.config.local.ts.
    const local = await import("./vite.config.local").catch(() => null);
    return local ? mergeConfig(config, local.default) : config;
});
