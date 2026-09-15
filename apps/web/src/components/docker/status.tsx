import type { ReactNode } from "react";
import { stackRunStatus, type ComposeServiceStatus, type ComposeStackRunStatus, type DockerStack } from "@central/shared";
import { cx, type Tone } from "../../utils";
import shared from "../../styles/shared.module.css";

/**
 * The one status vocabulary every Docker surface speaks — stacks list, stack
 * detail, containers list and the container drawer.
 *
 * Before this, the same state was coloured three different ways depending on
 * which table you were looking at (a stopped stack was grey when SC had a record
 * for it and red when it only saw containers; a service was grey when down while
 * the container backing it was red). The tone functions below are the only place
 * a state turns into a colour, so a badge means the same thing everywhere.
 */
export type StatusTone = Tone;

/**
 * The rule, applied to everything that can be up or down:
 *
 * - `ok` — running as intended.
 * - `warn` — in between: paused, restarting, or only some of a stack up.
 * - `err` — it exists and it isn't running.
 * - `muted` — there's nothing there at all, so nothing to be wrong — or it's
 *   a one-shot that finished, which is nothing being wrong either.
 */

/** Docker's container states, plus the raw `docker compose ps` strings
 *  ("exited (0)"), which carry a suffix — hence the prefix match. The server
 *  decides `completed` (exit 0 under a restart policy that won't bring the
 *  container back); here it just stops an "exited" from reading as red. */
export function containerTone(c: { state: string; completed?: boolean }): StatusTone {
    if (c.completed) {
        return "muted";
    }
    if (c.state.startsWith("running")) {
        return "ok";
    }
    if (c.state.startsWith("paused") || c.state.startsWith("restarting")) {
        return "warn";
    }
    return "err";
}

/** The badge's word: docker's state, except that a finished one-shot says
 *  "completed" — "exited" is what it says about a crash too. */
export function containerState(c: { state: string; completed?: boolean }): string {
    return c.completed ? "completed" : c.state;
}

export function stackTone(status: ComposeStackRunStatus): StatusTone {
    switch (status) {
        case "running":
            return "ok";
        case "partial":
            return "warn";
        // Containers exist and none of them run — so it reads exactly like every
        // container inside it. It used to be grey here and red one click deeper.
        case "stopped":
            return "err";
        // Nothing has been brought up: no containers to be stopped.
        case "down":
            return "muted";
    }
}

/** A service row and a container row now read identically: same words, same
 *  colour. A service with no container at all is down, like its stack. */
export function serviceTone(svc: ComposeServiceStatus): StatusTone {
    return svc.state ? containerTone({ state: svc.state, completed: svc.completed }) : "muted";
}

export function serviceState(svc: ComposeServiceStatus): string {
    return svc.state ? containerState({ state: svc.state, completed: svc.completed }) : "down";
}

/** Collapse a stack observed purely from container labels onto the same
 *  vocabulary a registered stack's status uses. */
export function observedStatus(obs: DockerStack): ComposeStackRunStatus {
    return stackRunStatus(obs.running, obs.containers, obs.completed);
}

export function StatusBadge({ tone, children, title }: { tone: StatusTone; children: ReactNode; title?: string }) {
    return <span className={cx(shared.badge, shared[`badge-${tone}`])} title={title}>{children}</span>;
}
