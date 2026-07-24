#!/usr/bin/env bun
// Writes an empty placeholder version of web-assets.generated.ts, which
// scripts/gen-web-assets.ts populates for real during a release build. It's gitignored,
// so a fresh clone has none — this creates it so a first typecheck resolves the import.
// Safe to run anytime; also called by build-agent.sh's EXIT trap to restore the
// placeholder after a release build.
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

console.log("Wrote empty generated-file stub.");
