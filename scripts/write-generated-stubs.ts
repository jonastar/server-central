#!/usr/bin/env bun
// Writes the empty placeholder version of web-assets.generated.ts, which
// scripts/gen-web-assets.ts populates for real during a release build. It's gitignored,
// so a fresh clone has none — this creates it so a first typecheck resolves the import.
//
// Safe to run anytime, and run often: by `postinstall`, by build-agent.sh's exit trap
// after a release build, and by `predev` before the control plane starts. That last one
// is the one that matters day to day — see the note below.
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

/**
 * Why dev resets this file rather than trusting whatever is there.
 *
 * A populated web-assets.generated.ts is a *release* artifact: it statically imports
 * every hash-named file in apps/web/dist so `bun build --compile` can embed the SPA.
 * In a source checkout it is never what you want, and when one is left behind — an
 * interrupted release build, a `gen-web-assets.ts` run by hand, a killed shell whose
 * EXIT trap never fired — dev breaks in two ways that don't look related to it:
 *
 *   1. The control plane thinks it has an embedded SPA (`HAS_EMBEDDED_WEB` in
 *      static.ts), so it serves that stale build instead of forwarding to Vite. Edits
 *      stop showing up, with nothing in the log to say why.
 *   2. The moment anything rebuilds apps/web/dist, Vite's content hashes change, the
 *      stale imports point at files that no longer exist, and the dev server won't
 *      start at all: "Cannot find module '../../web/dist/assets/MonacoPane-<hash>.js'".
 *
 * Resetting on every `bun run dev` makes both unreachable, whatever left the file
 * behind, without anyone having to know this file exists.
 */
const STUB = `// @ts-nocheck
// AUTO-GENERATED — do not edit by hand. Gitignored; scripts/write-generated-stubs.ts writes
// this empty version, scripts/gen-web-assets.ts populates it for release builds.
// Empty in dev (Vite serves the UI); release builds embed the SPA into the compiled binary.
export const WEB_ASSETS: Record<string, string> = {};
`;

const target = path.join(ROOT, "apps/server/src/web-assets.generated.ts");
const existing = await Bun.file(target).text().catch(() => null);

if (existing === STUB) {
    // Already in its dev shape. Say nothing: this runs before every dev start, and a
    // line of output on every start trains people to stop reading it.
    process.exit(0);
}

await Bun.write(target, STUB);
console.log(existing === null
    ? "Wrote empty generated-file stub."
    : "Reset web-assets.generated.ts to its empty dev stub (a release build had left it populated).");
