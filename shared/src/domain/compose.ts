import type { DockerStack } from "./docker";

// ---- Compose stacks ----------------------------------------------------------
//
// A ComposeStack is a directory on a host containing a compose file (source of
// truth for what runs — no SC-native service format) and, for stacks SC created
// or imported, `sc-stack.json`. Bind mounts are whatever the compose file says;
// SC doesn't impose a layout. Design: doc/idea_app_system.md.
//
// This is what SC *registered*; `DockerStack` above is what SC *observes* from
// container labels. They're merged by `project` in the host's Docker → Stacks
// section: a registered stack with no containers is simply down, and an observed
// stack with no record is one deployed by hand, which can be adopted.
//
// `project` is the `docker compose -p` value, fixed at create/import time so
// actions always target the same compose project regardless of what the compose
// file's own `name:`/directory-basename prediction would produce.

export interface ComposeStack {
    id: string;
    name: string;
    hostId: string;
    /** Absolute path on hostId. */
    dir: string;
    /** Relative to dir, default "compose.yaml". */
    composeFile: string;
    project: string;
    createdAt: number;
}

export interface ComposeServiceStatus {
    name: string;
    /** Container backing this service right now, absent when it has none.
     *  Lets the services table link straight to the container's detail page. */
    containerId?: string;
    image?: string;
    /** Raw state string from `docker compose ps` (e.g. "running", "exited (0)"), absent when the service has no container yet. */
    state?: string;
    ports?: string;
    up: boolean;
}

export type ComposeStackRunStatus = "running" | "partial" | "stopped" | "down";

export interface ComposeStackStatus {
    status: ComposeStackRunStatus;
    services: ComposeServiceStatus[];
}

/**
 * Everything the host's Compose stacks section renders, in one call.
 *
 * Reading this *adopts*: any compose project observed running on the host that
 * SC has no record of, and whose containers carry a `config_files` label
 * pointing at a real compose file, is registered on the spot. Adoption is
 * control-plane only — nothing is written to the host — so it's cheap and
 * reversible by removing the stack again.
 *
 * `observed` is every compose project seen on the host right now, for container
 * counts and states. A project in `observed` with no matching entry in `stacks`
 * is one adoption couldn't place (no usable `config_files` label); it still
 * renders, just without a detail page.
 */
export interface HostComposeStacks {
    available: boolean;
    error?: string;
    stacks: ComposeStack[];
    observed: DockerStack[];
}

/** Result of probing a candidate host directory before import — step 2 of the
 *  import flow ("Detected"). */
export interface ComposeStackDetection {
    composeFound: boolean;
    manifestFound: boolean;
    /** From the directory's basename — compose's own default project-name rule. */
    predictedName: string;
    services: string[];
    /** Set when a compose file was found but `docker compose config` failed or
     *  returned unparsable output — `services` stays `[]` in that case too, but
     *  this distinguishes "couldn't ask" from "genuinely no services declared". */
    composeError?: string;
    /** Bind mounts whose source resolves outside `dir` — these stay where they
     *  are on import; the Files tab only ever browses `dir` itself. */
    externalBindMounts: { source: string; target: string }[];
    namedVolumeCount: number;
}


/** SC-managed compose stacks — a directory + compose file on a host.
 *  See doc/idea_app_system.md. */
export interface ComposeOperations {
    list: { data: void; response: ComposeStack[] };
    // One host's section: registered stacks (adopting observed ones as a side
    // effect) plus what's running. See HostComposeStacks.
    listForHost: { data: { hostId: string }; response: HostComposeStacks };
    // The same merge, read-only: no adoption, so it's safe to poll. This is what
    // the stacks dashboard widget uses — a card on the landing page of every host
    // must not mutate the registry every 10s. See doc/idea_host_dashboard.md §2.
    readForHost: { data: { hostId: string }; response: HostComposeStacks };
    // Always scaffolds an empty compose.yaml + volumes/ under dir.
    // `content` seeds the new stack's compose.yaml (the "Paste YAML" path in the
    // new-stack modal); omitted, the file is scaffolded with a bare `services:`.
    create: { data: { name: string; hostId: string; dir: string; content?: string }; response: ComposeStack };
    /** Probes a candidate directory before import (step 2 of the import flow). */
    detect: { data: { hostId: string; dir: string }; response: ComposeStackDetection };
    /** Always mints a fresh id, even when dir already has a manifest. */
    import: { data: { hostId: string; dir: string; name: string }; response: ComposeStack };
    // Unregisters the stack. `deleteDir: true` also removes its directory (compose
    // file, manifest, and volumes/) from the host; otherwise it's left on disk.
    delete: { data: { stackId: string; deleteDir: boolean }; response: void };
    getStatus: { data: { stackId: string }; response: ComposeStackStatus };
    // `docker compose logs`, optionally scoped to one service — one-shot (not
    // streaming), same 30s exec ceiling as everything else pre-streaming-exec.
    getLogs: { data: { stackId: string; service?: string; tail?: number }; response: { logs: string } };
    // Validates in-editor compose content via `docker compose config`, against a
    // temp file — never touches the stack's real compose.yaml. Used by the Compose
    // tab's visual/YAML editor before Save, on top of client-side schema validation.
    validateContent: {
        data: { stackId: string; content: string };
        response: { valid: true } | { valid: false; error: string };
    };
}
