#!/usr/bin/env bun
// Cut a release: bump every workspace package.json to a single version, refresh the
// lockfile, and create a tagged commit. The tag (v<version>) is what the release CI
// workflow builds from, and shared/package.json is the version of record (it feeds
// AGENT_VERSION). All packages are kept in lockstep so the tag, AGENT_VERSION, and
// package versions never disagree.
//
// Usage:  bun run release [patch|minor|major|<x.y.z>]   (default: patch)
//
// Does NOT push — it prints the push commands so you can review the commit + tag first.
import { $ } from "bun";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
// shared first: it's the version of record (AGENT_VERSION reads it).
const PACKAGES = ["shared/package.json", "apps/server/package.json", "apps/web/package.json"];

function fail(msg: string): never {
    console.error(`✗ ${msg}`);
    process.exit(1);
}

function parse(v: string): [number, number, number] {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    if (!m) {
        fail(`Not a valid x.y.z version: "${v}"`);
    }
    return [Number(m![1]), Number(m![2]), Number(m![3])];
}

function isGreater(a: [number, number, number], b: [number, number, number]): boolean {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) {
            return a[i] > b[i];
        }
    }
    return false;
}

function nextVersion(current: string, bump: string): string {
    let [major, minor, patch] = parse(current);
    if (bump === "patch") {
        patch++;
    } else if (bump === "minor") {
        minor++;
        patch = 0;
    } else if (bump === "major") {
        major++;
        minor = 0;
        patch = 0;
    } else {
        // Explicit version.
        const target = parse(bump);
        if (!isGreater(target, [major, minor, patch])) {
            fail(`Target version ${bump} is not greater than current ${current}`);
        }
        return bump;
    }
    return `${major}.${minor}.${patch}`;
}

async function readVersion(file: string): Promise<string> {
    return (JSON.parse(await Bun.file(path.join(ROOT, file)).text()) as { version?: string }).version ?? fail(`${file} has no version`);
}

async function setVersion(file: string, version: string): Promise<void> {
    const full = path.join(ROOT, file);
    const text = await Bun.file(full).text();
    // Replace only the first (top-level) "version" field; dependency entries use their
    // package name as the key, so they're never matched.
    const updated = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
    if (updated === text) {
        fail(`Could not find a version field to update in ${file}`);
    }
    await Bun.write(full, updated);
}

const bump = process.argv[2] ?? "patch";

// Preflight: a clean tree so the release commit only contains the version bump +
// lockfile, and the tag doesn't exist yet.
const dirty = (await $`git -C ${ROOT} status --porcelain`.text()).trim();
if (dirty) {
    fail("Working tree is not clean — commit or stash changes before cutting a release.");
}

const current = await readVersion(PACKAGES[0]);
const version = nextVersion(current, bump);
const tag = `v${version}`;

if ((await $`git -C ${ROOT} tag --list ${tag}`.text()).trim()) {
    fail(`Tag ${tag} already exists.`);
}

console.log(`Releasing ${current} → ${version}  (tag ${tag})`);
for (const pkg of PACKAGES) {
    await setVersion(pkg, version);
    console.log(`  bumped ${pkg}`);
}

// Refresh the committed lockfile (versions changed) so CI's --frozen-lockfile passes.
await $`bun install`.cwd(ROOT);

await $`git -C ${ROOT} add ${PACKAGES} bun.lock`;
await $`git -C ${ROOT} commit -m ${`release ${tag}`}`;
await $`git -C ${ROOT} tag -a ${tag} -m ${`Release ${tag}`}`;

const branch = (await $`git -C ${ROOT} rev-parse --abbrev-ref HEAD`.text()).trim();
console.log(`\n✓ Committed and tagged ${tag} on ${branch}.`);
console.log(`Push to trigger the release build:\n  git push origin ${branch} && git push origin ${tag}`);
