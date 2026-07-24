#!/usr/bin/env bun
// Version flow:
//   - main (and any release/x.y.x branch) always sits on a pending "x.y.z-dev" version
//     except for the one commit that is the release itself.
//   - `bun run release`                cuts the pending version: strips "-dev", tags, commits.
//   - `bun run bump <type>`            starts the next dev cycle: computes the next
//     patch/minor/major version from the current (already-cut) version, sets it to
//     "x.y.z-dev", commits (no tag). Run manually wherever a new dev cycle should start —
//     after a main release (`bump minor`), or on a fresh release branch (`bump patch`).
//   - `bun run release branch <type>`  branches off the current released commit into a
//     release/x.y.x maintenance branch and bumps it, for patching an already-shipped
//     version without touching main's dev line.
//
// Every command prints what it's about to do and asks for y/n confirmation before making
// any change; pass --yes (or -y) to skip the prompt.
//
// shared/package.json is the version of record (AGENT_VERSION reads it); apps/server and
// apps/web are kept in lockstep so the tag, AGENT_VERSION, and package versions never disagree.
import { $ } from "bun";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
// shared first: it's the version of record (AGENT_VERSION reads it).
const PACKAGES = ["shared/package.json", "apps/server/package.json", "apps/web/package.json"];
const CHANGELOG = "changelog.md";

function fail(msg: string): never {
    console.error(`✗ ${msg}`);
    process.exit(1);
}

type Version = [number, number, number];
type Bump = "patch" | "minor" | "major";

function parsePlain(v: string): Version {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    if (!m) {
        fail(`Not a valid released x.y.z version: "${v}"`);
    }
    return [Number(m![1]), Number(m![2]), Number(m![3])];
}

function nextVersion([major, minor, patch]: Version, bump: Bump): Version {
    if (bump === "patch") {
        return [major, minor, patch + 1];
    }
    if (bump === "minor") {
        return [major, minor + 1, 0];
    }
    return [major + 1, 0, 0];
}

function format([major, minor, patch]: Version): string {
    return `${major}.${minor}.${patch}`;
}

function parseBumpType(arg: string | undefined): Bump {
    if (arg !== "patch" && arg !== "minor" && arg !== "major") {
        fail(`Expected "patch", "minor", or "major", got: ${arg ?? "(nothing)"}`);
    }
    return arg;
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

async function setAllVersions(version: string): Promise<void> {
    for (const pkg of PACKAGES) {
        await setVersion(pkg, version);
        console.log(`  set ${pkg} -> ${version}`);
    }
    // Refresh the committed lockfile (versions changed) so CI's --frozen-lockfile passes.
    await $`bun install`.cwd(ROOT);
}

async function requireCleanTree(): Promise<void> {
    const dirty = (await $`git -C ${ROOT} status --porcelain`.text()).trim();
    if (dirty) {
        fail("Working tree is not clean — commit or stash changes first.");
    }
}

async function requireAttachedBranch(): Promise<string> {
    const branch = (await $`git -C ${ROOT} rev-parse --abbrev-ref HEAD`.text()).trim();
    if (branch === "HEAD") {
        fail("Detached HEAD — checkout or create a branch before bumping (e.g. `bun run release branch patch`).");
    }
    return branch;
}

// Prints the plan and asks for y/n confirmation before any mutation runs. `confirm()` is
// Bun's global stdin prompt; --yes/-y (checked in autoYes) skips it for scripted use.
function confirmPlan(steps: string[], autoYes: boolean): void {
    console.log("About to:");
    for (const step of steps) {
        console.log(`  - ${step}`);
    }
    if (autoYes) {
        return;
    }
    if (!confirm("Proceed?")) {
        fail("Aborted.");
    }
}

// Cuts the "## Unreleased" section over to "## [x.y.z] - <date>" and opens a fresh
// empty "## Unreleased" above it, so changelog entries land under the right version
// with no extra step beyond writing them under Unreleased as they're made.
async function cutChangelog(version: string): Promise<void> {
    const full = path.join(ROOT, CHANGELOG);
    const text = await Bun.file(full).text();
    // Match only the heading on its own line — "Unreleased" also appears in the intro prose.
    const headingLine = /^## Unreleased$/m;
    if (!headingLine.test(text)) {
        fail(`Could not find a "## Unreleased" heading line in ${CHANGELOG}`);
    }
    const date = new Date().toISOString().slice(0, 10);
    const updated = text.replace(headingLine, `## Unreleased\n\n## [${version}] - ${date}`);
    await Bun.write(full, updated);
}

// `bun run release` — cut the currently pending "-dev" version into a release.
async function cut(autoYes: boolean): Promise<void> {
    await requireCleanTree();

    const current = await readVersion(PACKAGES[0]);
    const devMatch = /^(\d+\.\d+\.\d+)-dev$/.exec(current);
    if (!devMatch) {
        fail(`${PACKAGES[0]} is "${current}", not a pending "x.y.z-dev" version — nothing to cut. Run "bun run bump <patch|minor|major>" first.`);
    }
    const version = devMatch[1]!;
    const tag = `v${version}`;

    if ((await $`git -C ${ROOT} tag --list ${tag}`.text()).trim()) {
        fail(`Tag ${tag} already exists.`);
    }

    confirmPlan(
        [
            `set ${PACKAGES.join(", ")} version ${current} -> ${version}`,
            `cut ${CHANGELOG} Unreleased -> [${version}]`,
            `commit "release ${tag}"`,
            `tag ${tag}`,
        ],
        autoYes,
    );

    console.log(`Cutting ${current} → ${version}  (tag ${tag})`);
    await setAllVersions(version);
    await cutChangelog(version);
    console.log(`  cut ${CHANGELOG} Unreleased → [${version}]`);

    await $`git -C ${ROOT} add ${PACKAGES} bun.lock ${CHANGELOG}`;
    await $`git -C ${ROOT} commit -m ${`release ${tag}`}`;
    await $`git -C ${ROOT} tag -a ${tag} -m ${`Release ${tag}`}`;

    const branch = (await $`git -C ${ROOT} rev-parse --abbrev-ref HEAD`.text()).trim();
    console.log(`\n✓ Committed and tagged ${tag} on ${branch}.`);
    console.log(`Push to trigger the release build:\n  git push origin ${branch} && git push origin ${tag}`);
    console.log(`Then start the next dev cycle:\n  bun run bump <patch|minor|major>`);
}

// `bun run bump <type>` — start a new dev cycle from the current released version.
// skipConfirm is used by branchAndBump, which already showed one combined plan covering
// both the branch creation and this bump.
async function bump(bumpType: Bump, opts: { autoYes: boolean; skipConfirm?: boolean }): Promise<void> {
    await requireCleanTree();
    const branch = await requireAttachedBranch();

    const current = await readVersion(PACKAGES[0]);
    if (current.includes("-")) {
        fail(`${PACKAGES[0]} is already "${current}" — a dev cycle is already pending. Run "bun run release" to cut it before bumping again.`);
    }

    const version = `${format(nextVersion(parsePlain(current), bumpType))}-dev`;

    if (!opts.skipConfirm) {
        confirmPlan([`set ${PACKAGES.join(", ")} version ${current} -> ${version}`, `commit "bump to ${version}" on ${branch}`], opts.autoYes);
    }

    console.log(`Bumping ${current} → ${version}`);
    await setAllVersions(version);

    await $`git -C ${ROOT} add ${PACKAGES} bun.lock`;
    await $`git -C ${ROOT} commit -m ${`bump to ${version}`}`;

    console.log(`\n✓ ${branch} is now on ${version}.`);
}

// `bun run release branch <type>` — branch off the current released commit into a
// release/x.y.x maintenance branch and bump it, for patching an already-shipped version
// without touching main's dev line.
async function branchAndBump(bumpType: Bump, autoYes: boolean): Promise<void> {
    await requireCleanTree();
    // No requireAttachedBranch() here — the normal starting point is a detached HEAD from
    // a checked-out release tag. `git checkout -b` below attaches to the new branch, and
    // the nested bump() re-checks from there.

    const current = await readVersion(PACKAGES[0]);
    if (current.includes("-")) {
        fail(`${PACKAGES[0]} is "${current}", not a released x.y.z version — checkout a release tag first.`);
    }

    const [major, minor] = parsePlain(current);
    const branchName = `release/${major}.${minor}.x`;

    if ((await $`git -C ${ROOT} branch --list ${branchName}`.text()).trim()) {
        fail(`Branch ${branchName} already exists — checkout it directly and run "bun run bump ${bumpType}" instead.`);
    }

    const nextDev = `${format(nextVersion(parsePlain(current), bumpType))}-dev`;
    confirmPlan(
        [
            `create branch ${branchName} from ${current}`,
            `set ${PACKAGES.join(", ")} version ${current} -> ${nextDev}`,
            `commit "bump to ${nextDev}" on ${branchName}`,
        ],
        autoYes,
    );

    await $`git -C ${ROOT} checkout -b ${branchName}`;
    console.log(`✓ Created ${branchName} from ${current}.`);
    await bump(bumpType, { autoYes, skipConfirm: true });
}

const rawArgs = process.argv.slice(2);
const autoYes = rawArgs.includes("--yes") || rawArgs.includes("-y");
const [cmd, arg] = rawArgs.filter((a) => a !== "--yes" && a !== "-y");

if (cmd === undefined) {
    await cut(autoYes);
} else if (cmd === "bump") {
    await bump(parseBumpType(arg), { autoYes });
} else if (cmd === "branch") {
    await branchAndBump(parseBumpType(arg), autoYes);
} else {
    fail(`Unknown command: ${cmd}\nUsage:\n  bun run release\n  bun run release branch <patch|minor|major>\n  bun run bump <patch|minor|major>`);
}
