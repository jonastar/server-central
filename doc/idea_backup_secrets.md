# Backup, Config Tracking & Secrets

Status: idea / design. Not yet scheduled. Depends on
[idea_stack_registry.md](idea_stack_registry.md) — per-volume classification has to live
on the stack registry's records, so the registry lands first.

## Goal

Server Central becomes the abstraction layer above the OS: every compose stack, every
piece of app configuration, and all of SC's own state is declared in SC and backed up to
a central repository. Reinstall the OS, point a fresh SC at the repo, and the fleet comes
back.

Bulk data is explicitly **out of scope** — it needs its own flow (ZFS snapshots, restic,
whatever the operator already runs). The design's job is to be _honest_ about that
boundary rather than to silently omit things and claim success.

Two things drive every decision below:

1. **Secrets can't be treated like config.** A backup that contains them needs a key, and
   the key can't be in the backup. There is always exactly one out-of-band artifact; the
   design's job is to make it singular and small.
2. **Config drift is the real enemy.** The failure mode this is meant to fix is the one
   every ops team has: nobody tracks `postgresql.conf`, someone tunes `work_mem` at 2am,
   and six months later nothing on disk matches anything in version control. "It's in git"
   is worthless unless something continuously compares.

## Threat model

Stated plainly, because it determines where the master key lives:

- **The backup repo is untrusted.** It may be a private GitHub repo, but assume it leaks.
- **The control-plane host is trusted.** It already holds every agent token, the TLS CA
  key, and the OIDC signing key. Nothing in this design makes that worse.

So the master key sits in a file under `CONFIG_DIR` ([config.ts](../apps/server/src/config.ts))
and SC boots unattended. That protects against the realistic accident — pushing your
homelab's config to a host you don't control — and does not pretend to protect against
root on the control plane.

Passphrase-at-boot is deliberately **not** the default. Every unattended reboot would
become a manual step, and the first 3am reboot ends with the passphrase written to disk
anyway. Leave it as an opt-in flag later.

---

## 1. Classification by authorship

The useful axis is not "infra config vs app config" — it's **who writes it**. Authorship
predicts everything downstream: whether it's diffable, whether restore can merge or must
replace wholesale, whether capture needs the container stopped, and whether it belongs in
git history at all.

| class           | writer         | form       | destination   | restore           |
| --------------- | -------------- | ---------- | ------------- | ----------------- |
| SC state        | SC             | structured | git repo      | reconcile         |
| Declared config | operator       | text       | git repo      | render + apply    |
| Secrets         | SC or operator | structured | secret blob   | materialize       |
| App state       | the app        | opaque     | archive store | wholesale replace |
| Bulk data       | app / users    | huge       | —             | out of scope      |

Secrets get their own row rather than being a flag on the others because they are the only
class with a **retention** requirement (see §3).

### Why "which app layer" is the wrong question

Grafana is the clarifying example. Dashboards are ambiguous not because they're inherently
config-ish-data, but because **grafana is either class depending on how you run it**:

- Provisioned from `/etc/grafana/provisioning/*.yaml` mounted out of the repo →
  operator-authored. Plaintext, diffable, git tells you who changed which panel.
- Saved through the UI → lives in `grafana.db`. App-authored, opaque SQLite, needs
  quiescing to capture, restore is all-or-nothing.

Same app, same information, completely different handling — decided by a config choice the
operator makes. That generalizes: Home Assistant YAML vs `.storage`, Caddyfile vs its admin
API, Gitea's `app.ini` vs its database.

**Consequence: SC should have an opinion, not just a taxonomy.** Stack templates should
mount provisioning files from the repo wherever the app supports it, because that's the
only side of the line where git buys anything.

---

## 2. Volume classification

Mount _type_ does not predict class and never will:

- `/var/lib/grafana` — named volume, app config
- `/mnt/tank/media:/media` — bind mount, bulk data
- `/config` in every linuxserver.io image — bind mount, app config

So it must be **declared per volume**, once, at stack adoption. Four values:

| class         | meaning                                             | destination                       |
| ------------- | --------------------------------------------------- | --------------------------------- |
| `declared`    | app only reads it; SC owns and renders it           | git repo (plaintext, `:ro` mount) |
| `captured`    | app writes it; SC snapshots it opaquely             | archive store (encrypted)         |
| `regenerable` | app writes it, cheap to rebuild, expensive to store | nothing                           |
| `external`    | bulk data, operator's own backup flow               | nothing                           |

### The determining question

Not "is this config or data" — that's the hard, fuzzy one. Ask instead:V

> **Does the app write to this volume at runtime?**

- **No** (Caddyfile, provisioning YAML, `prometheus.yml`, `nginx.conf`) → `declared`. SC
  renders it, the app consumes it, nothing writes back. Fully declarative and reconcilable.
- **Yes** (`grafana.db`, HA `.storage`, jellyfin's config dir) → `captured`. The app owns
  it; SC can only snapshot and replace wholesale, and needs the container quiesced for a
  consistent copy.

That test is answerable by looking at the app, and it explains _why_ the two need different
destinations instead of merely asserting it.

### `regenerable` vs `external`

Both mean "SC stores nothing," so they look redundant. They differ in what **restore
reports**, which is the entire point:

- `external` → _"you must restore this yourself from your own backup."_
- `regenerable` → _"this rebuilds itself; expect a long first scan."_

Jellyfin's trickplay images and metadata cache are tens of GB of genuinely-config-shaped
data that should never enter a backup, but silently omitting them makes restore a liar.

### `unclassified` is a blocking state

The highest-stakes decision in the design is the **default**, and the answer is that there
isn't one. An unclassified volume is a loud, blocking state: **SC refuses to report a stack
as backed up until every volume has a class.**

Defaulting to `external` gives silent incompleteness — restore says success and Jellyfin
comes up with an empty library. Defaulting to `captured` silently uploads a media library.
A ten-second decision per volume at adoption is cheap; a backup system that lies is not.

### Mixed volumes

Many real apps put both classes in one tree — Home Assistant's `/config` holds
operator-authored `configuration.yaml` _and_ app-authored `.storage/`.

**v1: volume-level granularity only.** A mixed volume is `captured` wholesale, and the
escape hatch is to **mount the declarative files separately** (HA lets you bind-mount
`configuration.yaml` on its own; most apps do). That's better compose hygiene anyway and is
consistent with SC having an opinion. Path globs within a volume are a v2 concern, once
something genuinely can't be split.

---

## 3. Destinations

Four, and the split between the last two matters more than it looks:

| destination   | contents                                                     | encrypted | retention                      |
| ------------- | ------------------------------------------------------------ | --------- | ------------------------------ |
| git repo      | declared config, SC state (non-secret fields), tracked files | no        | full history                   |
| secret blob   | secrets only                                                 | yes       | **bounded** (last N)           |
| archive store | `captured` volumes                                           | yes       | snapshot policy (daily/weekly) |
| —             | `regenerable`, `external`                                    | n/a       | none                           |

### Why the secret blob is not in git

Key compromise plus repo access decrypts _every historical version_ of the blob, so every
secret that ever existed is exposed — including ones long since rotated away. The practical
damage is narrower than it sounds (secrets rotated _because_ they leaked are already burnt),
but the structural cost is real: **with retained ciphertext, rotation stops buying anything
against key compromise.**

The decisive argument is that it can't be undone. Force-push and history rewrite do not
reliably delete on GitHub — dangling objects survive, forks retain, and it takes a support
ticket. "We'll clean it up later" is not available, so the blob must never enter the repo
in the first place.

### Bounded, not zero, retention

Zero generations is dangerous: one truncated write, or one blob encrypted to a key that's
since been lost, and everything is gone with no undo. The window should be small (last N
versions, or 30 days) — enough that rotation eventually means something, enough margin to
recover from a bad write.

This argues for **restic/kopia as the store rather than anything git-shaped**, because those
actually delete: `forget --keep-last N && prune` removes the data. Git cannot offer that.
They also bring encryption, integrity, dedup, and S3/B2/SFTP backends for free.

One restic repo, two policies:

- secret blob — tiny, snapshot on every change, `keep-last 10`
- `captured` volumes — large, nightly, `keep-daily 7 / keep-weekly 4`

One key, one credential, two retention rules. **Volumes must not go into the secret-blob
policy** — a 200MB `grafana.db` changing on every dashboard save either blows up the
retention window or defeats its purpose.

Note also that rotating a _secret_ buys no forward secrecy if the master key is unchanged
and old ciphertext exists anywhere. The property comes from master-key rotation **and**
retention expiry together.

### Binding the halves

Each git commit records the **expected blob snapshot id**. A checkout then states which
secret generation it needs, and restore can detect _"this config references
`jellyfin/db_password` but your blob predates it"_ instead of silently coming up broken.
Cheap to implement, catches the split-brain restore.

---

## 4. Secrets

### Compose files never contain secrets

They contain references (`${sc:jellyfin/db_password}`). SC materializes the real `.env` onto
the target host at deploy time, mode 0600, as a **derived artifact that is never the source
of truth**. The repo keeps a fully readable, reviewable config tree; exactly one artifact is
opaque.

Same mechanism for `declared` volumes: SC renders templates into them on deploy. Which gives
a hard rule — **templating and capture are mutually exclusive per volume.** If SC renders
into a directory the app also writes, next deploy either clobbers the app's changes or SC's
render is overwritten and the secret silently goes stale. Enforce it in the UI, don't leave
it a convention.

### Generate rather than collect

Most stack secrets are arbitrary random strings — DB passwords, session keys. If SC generates
them (`generate: 32` in the stack definition) the operator never sees or types them and there
is nothing to import. That shrinks the irreplaceable set to genuinely external credentials:
third-party API keys, ACME DNS tokens, Plex claim tokens.

Worth marking the two differently in the UI, because recovery semantics differ: a generated
secret can be re-rolled if you'll accept resetting the app; an external one is gone forever.

### Push, never fetch

SC pushes secrets to hosts and materializes them on disk. It is **not** in the runtime path —
no fetch-at-container-start. If SC is down, hosts keep running and stacks keep restarting.
Non-negotiable for something positioned as an abstraction layer above the OS.

---

## 5. Tracked files — the drift answer

`postgresql.conf` is the case that breaks volume-level classification: it lives _inside_
`PGDATA`, the same volume as the database files. Volume-level classification makes that
volume `external`, and the config goes untracked — precisely the failure this design exists
to fix.

Two answers, and both are wanted.

### 5a. Relocate config out of the data dir

Postgres supports it natively, as do most apps that bury config in a data dir:

```yaml
command: >
  postgres
  -c config_file=/etc/postgresql/postgresql.conf
  -c hba_file=/etc/postgresql/pg_hba.conf
volumes:
  - ./config:/etc/postgresql:ro # declared, from the repo
  - pgdata:/var/lib/postgresql/data # external
```

Now it's a `declared` volume, mounted `:ro` so it cannot drift, and git is genuinely
authoritative. Better still for postgres: `include_dir 'conf.d'` and mount only a fragment
directory — additive, and survives the base file being rewritten.

This is where opinionated stack templates pay for themselves. Nobody tracks
`postgresql.conf` because the default layout buries it and nobody re-plumbs it on day one.
If SC's template ships pre-relocated, tracking is free and the decision is never made.

### 5b. The `tracked` class

Relocation doesn't always exist and doesn't help already-adopted stacks. So: a class that
operates on **individual file paths, inside any volume, regardless of that volume's class.**

SC reads the file on a schedule and commits it to the repo when it changes. No ownership, no
rendering, no conflict resolution — SC observes and records. `/var/lib/postgresql/data/postgresql.conf`
can be tracked while the volume around it stays `external`. The result is `git log` and
`git blame` on a file SC does not manage.

Cheap to build: `readFile` plus commit-if-changed. The agent primitive already exists
([host-agent.ts](../apps/server/src/host-agent.ts)).

**Two caveats.**

- **Secrets.** `postgresql.conf` is clean, but a tracked `config.php` or `app.ini` carries DB
  credentials. Tracked files need a per-file secret flag routing them to the encrypted store
  instead of the plaintext repo. Do **not** auto-redact — pattern-matching secrets out of
  arbitrary config formats fails silently and in the wrong direction.
- **Restore is not symmetric.** SC doesn't own a tracked file, so restoring one into a
  freshly-initialized data volume is best-effort at best (postgres writes its own
  `postgresql.conf` at `initdb` time). **Tracked gives you knowledge; declared gives you
  recovery.** The UI must not let anyone read tracked as backed-up.

### 5c. Drift detection is the actual deliverable

Being in git buys nothing if nothing ever compares. SC periodically hashes what's on the host
against what it holds:

- `declared` — divergence means someone exec'd in and edited a file SC owns. That's an
  **alert**, plus one-click re-render.
- `tracked` — divergence is expected. SC commits it and shows the diff. That's an **audit
  trail**.

Same mechanism, opposite response. Without it, the repo is accurate exactly on the day it was
set up.

### 5d. Graduation path

This gives adoption a shape that doesn't demand doing it right up front:

1. Adopt an existing stack → everything is `captured` / `external`. Zero visibility, but
   nothing is lost.
2. Point SC at specific files → `tracked`. History and drift alarms without touching the
   running stack.
3. Once it's clear what actually changes, relocate it and promote to `declared`. Git becomes
   authoritative, mount goes `:ro`.

Most files will sit at step 2 indefinitely, and that's fine — step 2 already beats the status
quo it's replacing.

---

## 6. SC's own state

SC's state does **not** classify atomically per file — it needs **field-level** classification
in the exporter. The plaintext half is exactly the "what changed in my infra this week" diff
worth having; the encrypted half stays small.

Current contents of `CONFIG_DIR`:

| file                                                               | disposition                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------ |
| `config.json`                                                      | repo                                                   |
| `agents.json` ([fleet.ts](../apps/server/src/fleet.ts))            | repo                                                   |
| `agent-tokens.json`                                                | **blob**                                               |
| `tasks.json`                                                       | repo (or drop — run history, not config)               |
| `users.json` ([auth.ts](../apps/server/src/auth.ts))               | split: identities/roles → repo, password hashes → blob |
| `sessions.json`                                                    | **neither** — let them expire                          |
| `proxy.json` ([proxy/store.ts](../apps/server/src/features/proxy/store.ts)) | repo                                                   |
| `apps.json` ([oidc/store.ts](../apps/server/src/features/oidc/store.ts))    | split: id/redirect URIs → repo, `secretHash` → blob    |
| `oidc-signing-key.json`                                            | **blob**                                               |
| `tls/` ([tls.ts](../apps/server/src/tls.ts))                       | **blob** — CA key + cert                               |
| `agent-binaries/`                                                  | **neither** — cache, re-downloadable                   |

Backing up the TLS CA key and `agent-tokens.json` is what turns restore from "re-enroll every
agent via `bootstrap.sh`" into "agents reconnect on their own." That's the difference between
a demo and something worth trusting.

---

## 7. Recovery

### The bundle

After a bare-metal reinstall there is nothing, and four things are needed: the git repo URL,
a git credential, the restic repo URL, and the restic password. Make it **one pasteable
blob** the setup wizard emits exactly once — print it, password-manager it, QR it.

If restore needs two secrets from two places, one of them will be lost. The restore wizard
takes that single paste and rebuilds everything.

### Ordering is load-bearing

```
git checkout
  → decrypt secret blob (verify snapshot id matches the commit)
  → materialize .env + render declared volumes
  → restore captured volumes
  → docker compose up
```

Volumes must land **before** first start. Start containers first and they initialize fresh
state, which then gets overwritten mid-flight — or worse, merged into.

### Quiescing

`captured` volumes with live SQLite (`grafana.db`, HA `.storage`, jellyfin) don't tar
consistently with an open WAL. SC must stop the stack before capture, or snapshot at the
filesystem layer (ZFS is available on the TrueNAS hosts). This is orchestration work — driving
restic and sequencing stack stop/start — **not** a reason to build a chunked encrypted
uploader.

---

## Files touched

- [`shared/src/index.ts`](../shared/src/index.ts) — `VolumeClass` union, per-volume
  classification on the stack registry's records, `TrackedFile`, secret-reference syntax,
  backup status/drift shapes.
- Stack registry records ([idea_stack_registry.md](idea_stack_registry.md)) — the per-volume
  metadata has to hang off `StackRoot`, which is why that lands first.
- New secret store + master key under `CONFIG_DIR`; new git/restic driver in the control plane.
- A new feature slice under `apps/server/src/features/` — classification CRUD, backup /
  restore / drift-check ops (see [idea_feature_convention.md](idea_feature_convention.md)).
- Task system ([docs/task-system.md](../docs/task-system.md)) — backup, restore, and drift-scan
  are long-running and belong as task kinds, not request/response ops (`exec`'s 30s timeout
  rules out the direct path anyway).
- Web — volume classification at stack adoption, the unclassified blocking state, drift alerts,
  recovery-bundle display, restore wizard.

## Build order

1. **Secret store + master key + templating.** Standalone value: stacks stop having plaintext
   passwords in compose files. No git, no restic yet.
2. **Volume classification + the unclassified blocking state.** Metadata only; nothing backs
   up yet. Forces the taxonomy to survive contact with real stacks early.
3. **Git repo export** — declared config + SC state, plaintext. First real "it's in version
   control" milestone.
4. **Tracked files + drift detection.** Highest value-per-line in the whole design and depends
   only on step 3.
5. **restic archive store** — secret blob with bounded retention, then `captured` volumes with
   quiescing.
6. **Recovery bundle + restore wizard.** Last, because it's only testable once 1–5 produce
   something to restore from.

## Open questions

- **Does SC own the repo, or reconcile from it?** SC-as-writer (repo is an output) is far
  simpler. GitOps (repo is truth, you edit compose in your editor and SC follows) is more
  powerful but needs conflict handling for out-of-band edits, and muddies the secrets flow —
  now the operator needs the key locally too, not just SC. **Leaning SC-as-writer for v1**, with
  drift detection covering most of what GitOps would buy.
- Where the master key lives on disk, and whether to support wrapping it with a TPM or the OS
  keyring as an opt-in hardening step.
- Whether `tasks.json` belongs in the repo at all — it's run history, and it churns.
- One restic repo with two retention policies, or two repos? One key is simpler; two makes the
  policies harder to misconfigure.
- Drift-scan cadence, and whether it's per-node (agent-side hashing, cheap) or control-plane
  pull (simpler, more traffic).
- How `regenerable` interacts with the reverse proxy's Caddy state — applied config persists
  locally by design ([idea_reverse_proxy.md](idea_reverse_proxy.md)), so it's arguably
  regenerable-from-SC rather than captured.
