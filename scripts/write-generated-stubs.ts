#!/usr/bin/env bun
// Writes the empty dev-mode versions of the generated files that build-agent.sh
// temporarily populates for release builds (web-assets.generated.ts, build-info.generated.ts).
// Both are gitignored, so a fresh clone has neither — this creates them so `bun run dev`
// and typecheck resolve their imports. Safe to run anytime; also called by build-agent.sh's
// EXIT trap to restore the empty state after a release build.
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

await Bun.write(
    path.join(ROOT, "apps/server/src/web-assets.generated.ts"),
    `// @ts-nocheck
// AUTO-GENERATED — do not edit by hand. Gitignored; scripts/write-generated-stubs.ts writes
// this empty version, scripts/gen-web-assets.ts populates it for release builds.
// Empty in dev (Vite serves the UI); release builds embed the SPA into the compiled binary.
export const WEB_ASSETS: Record<string, string> = {};
`,
);

await Bun.write(
    path.join(ROOT, "shared/src/build-info.generated.ts"),
    `// AUTO-GENERATED — do not edit by hand. Gitignored; scripts/write-generated-stubs.ts writes
// this empty version. Empty for source runs, tests, and release builds (plain x.y.z
// AGENT_VERSION); scripts/build-agent.sh stamps a git-commit dev suffix here for local builds.
export const DEV_SUFFIX = "";
`,
);

console.log("Wrote empty generated-file stubs.");
