import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Several test files isolate config.ts's data dir (agents.json, agent-tokens.json,
// config.json, tasks.json) by `process.chdir()`-ing to a per-test tmp dir. But
// Fleet's `persistState()` (and other config.ts writes) are fire-and-forget — if
// one is still in flight when a test's `afterAll` restores `cwd` to the real repo
// root, its *relative* path resolves against the real directory instead. That's
// not hypothetical: it's exactly how a stray write once clobbered a real running
// dev instance's `.sc-data/agents.json` with a single fake test machine.
//
// The actual fix: force SC_DATA_DIR to one absolute, this-run-only directory
// before any test file — and so config.ts's module-level `CONFIG_DIR` const —
// loads. An absolute path is resolved the same regardless of `cwd`, so no chdir
// race anywhere in the suite can land a write outside this throwaway directory
// ever again. (Test files' own per-file tmp dirs still isolate everything else —
// TLS bundles, downloaded binaries, etc. — this only affects config.ts's paths,
// and no test reads those files back to assert on them, so sharing one directory
// across files for just this purpose is harmless.)
process.env.SC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test-data-"));

// Same reasoning for the *agent* side of the suite: a live agent with no install
// data dir keeps its state (machine-id fallback, state.json) under SC_AGENT_DIR,
// defaulting to ~/.sc-agent. Test agents inherit this env, so pin it here rather
// than let them scribble in the developer's home directory. Tests that read the
// state file back set their own SC_AGENT_DIR per spawn.
process.env.SC_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test-agent-"));
