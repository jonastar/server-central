// Per-machine dev server override, merged into vite.config.ts if present. Copy this
// file to `vite.config.local.ts` (gitignored) and edit — it's for settings specific
// to your machine/network that shouldn't be committed for everyone else.
import type { UserConfig } from "vite";

export default {
    server: {
        // Bind all interfaces so the dev server is reachable over the tailnet.
        host: true,
        // Vite rejects Host headers it doesn't know; allow the tailnet names.
        // A leading dot matches subdomains, e.g. homelab.tail1234.ts.net.
        allowedHosts: ["homelab", ".ts.net"],
    },
} satisfies UserConfig;
