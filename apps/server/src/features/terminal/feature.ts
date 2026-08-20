import type { UserInfo } from "@central/shared";
import { dockerContainerShellCommand } from "../docker/docker";
import { resolveShellUser } from "../system-users/system-users";
import type { Feature } from "../../feature";
import type { Fleet } from "../../fleet";
import type { ShellSession } from "../../host-agent";

export function createTerminalFeature(): Feature {
    return {
        descriptor: {
            id: "terminal",
            name: "Terminal",
            description: "Interactive shell sessions into a host or container.",
            experimental: false,
        },
    };
}

/**
 * Resolves and opens the PTY session for a `/terminal` WebSocket connection.
 * The connection lifecycle itself (open/message/close, `WsData`) stays
 * hand-written in index.ts — same precedent as routes.ts's hash-parsing in
 * the frontend design doc: one global concern, genuinely intertwined with the
 * single `Bun.serve` instance, not per-feature boilerplate.
 */
export async function openTerminalShell(fleet: Fleet, serverId: string, containerId: string | null, user: UserInfo): Promise<ShellSession> {
    const agent = fleet.get(serverId);
    return containerId
        // Container terminals run whatever `docker exec` resolves to inside
        // the container — a separate identity boundary from the host OS
        // user mapping below, same as the existing one-shot docker exec.
        ? agent.openShell(80, 24, null, dockerContainerShellCommand(containerId))
        // Host terminals run as the caller's mapped OS account; unmapped
        // operator/viewer accounts are refused here (null = agent's own user, root).
        : agent.openShell(80, 24, resolveShellUser(user));
}
