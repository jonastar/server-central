import { defineConfig, mergeConfig, type UserConfig } from "vite";
import react from "@vitejs/plugin-react";

const config: UserConfig = {
    plugins: [react()],
    server: {
        port: 5151,
    },
};

export default defineConfig(async () => {
    // Optional gitignored per-machine override (e.g. server.host/allowedHosts for
    // tailnet access) — copy vite.config.local.example.ts to vite.config.local.ts.
    const local = await import("./vite.config.local").catch(() => null);
    return local ? mergeConfig(config, local.default) : config;
});
