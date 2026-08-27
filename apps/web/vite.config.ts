import { defineConfig, mergeConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Control plane the dev server proxies to. `VITE_API_PORT` points it at a control
 * plane on another port, so you can develop against the e2e lab (which publishes
 * one on 4241) without stopping your own.
 *
 * The app itself only ever uses same-origin relative paths — see apps/web/src/api.ts
 * — so this proxy is what stands in, during dev, for the single origin a released
 * build gets by being served by the control plane itself.
 */
const API_PORT = Number(process.env.VITE_API_PORT ?? 4141);
const API_TARGET = `http://127.0.0.1:${API_PORT}`;

const config: UserConfig = {
    plugins: [react()],
    server: {
        // SC_WEB_PORT lets a second dev server run alongside the usual one — the
        // e2e lab starts one on 5251 so it doesn't fight `bun run dev:web`.
        port: Number(process.env.SC_WEB_PORT) || 5151,
        proxy: {
            // HTTP only — deliberately no `ws: true` on any of these. Vite 5 proxies
            // through `http-proxy`, whose websocket upgrade handling doesn't work
            // under Bun: the upgrade reaches the control plane and it answers 101,
            // but nothing written back to the client socket is ever delivered, so the
            // browser hangs in CONNECTING. Setting `ws: true` doesn't fail loudly —
            // it just makes /api/events and /api/terminal hang, which surfaces as a
            // UI stuck on "connecting". The app sends its sockets straight to the
            // control plane in dev instead; see DEV_WS_PORT in src/api.ts.
            "/api": { target: API_TARGET, changeOrigin: true },
            // OIDC lives outside /api (fixed by spec relative to the issuer root).
            // /oidc/authorize is deliberately absent: it's a browser navigation the
            // SPA itself renders, so it must stay with the dev server.
            "/oidc/token": { target: API_TARGET, changeOrigin: true },
            "/oidc/userinfo": { target: API_TARGET, changeOrigin: true },
            "/.well-known": { target: API_TARGET, changeOrigin: true },
        },
    },
};

export default defineConfig(async () => {
    // Optional gitignored per-machine override (e.g. server.host/allowedHosts for
    // tailnet access) — copy vite.config.local.example.ts to vite.config.local.ts.
    const local = await import("./vite.config.local").catch(() => null);
    return local ? mergeConfig(config, local.default) : config;
});
