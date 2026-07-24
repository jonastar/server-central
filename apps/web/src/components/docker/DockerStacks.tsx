import { useCallback, useEffect, useState } from "react";
import type { DockerStack, DockerStacksState, StackAction } from "@central/shared";
import { api, runTaskAndWait } from "../../api";
import { cx } from "../../utils";
import { EmptyState, ErrorBanner } from "../ui";
import styles from "./DockerStacks.module.css";
import shared from "../../styles/shared.module.css";

const REFRESH_MS = 10_000;

function stackBadge(stack: DockerStack): "badge-ok" | "badge-err" | "badge-warn" {
    if (stack.running === stack.containers) {
        return "badge-ok";
    }
    if (stack.running === 0) {
        return "badge-err";
    }
    return "badge-warn";
}

export function DockerStacks({ serverId, onViewContainers }: {
    serverId: string;
    onViewContainers: (project: string) => void;
}) {
    const [state, setState] = useState<DockerStacksState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            setState(await api("dockerStacks", { serverId }));
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [serverId]);

    useEffect(() => {
        setState(null);
        void load();
        const timer = setInterval(() => void load(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [load]);

    async function action(stack: DockerStack, act: StackAction) {
        if ((act === "stop" || act === "down") && !confirm(`${act} stack "${stack.project}"?`)) {
            return;
        }
        setBusy(stack.project);
        try {
            await runTaskAndWait({ kind: "docker_stack_action", project: stack.project, action: act }, serverId);
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    }

    if (error && !state) {
        return <ErrorBanner>{error}</ErrorBanner>;
    }
    if (state === null) {
        return <EmptyState>Loading…</EmptyState>;
    }
    if (!state.available) {
        return <EmptyState>Docker is not available on this server{state.error ? `: ${state.error}` : "."}</EmptyState>;
    }

    return (
        <section className={shared.panel}>
            {error && <ErrorBanner>{error}</ErrorBanner>}
            <h3>Stacks ({state.stacks.length})</h3>
            {state.stacks.length === 0 ? (
                <EmptyState>No compose stacks detected.</EmptyState>
            ) : (
                <table className={shared["data-table"]}>
                    <thead>
                        <tr><th>Stack</th><th>Containers</th><th>States</th><th>Config files</th><th /></tr>
                    </thead>
                    <tbody>
                        {state.stacks.map((s) => (
                            <tr key={s.project} className={cx(busy === s.project && shared["row-busy"])}>
                                <td>
                                    <button className={styles["link-btn"]} onClick={() => onViewContainers(s.project)}>
                                        <b>{s.project}</b>
                                    </button>
                                </td>
                                <td>
                                    <span className={cx(shared.badge, shared[stackBadge(s)])}>{s.running}/{s.containers}</span>
                                </td>
                                <td className={shared.dim}>{s.states.join(", ")}</td>
                                <td className={cx(shared.dim, shared.mono, shared["cmd-cell"])} title={s.configFiles}>{s.configFiles || "—"}</td>
                                <td className={shared["row-actions-always"]}>
                                    <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy !== null} onClick={() => void action(s, "start")}>Start</button>
                                    <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy !== null} onClick={() => void action(s, "restart")}>Restart</button>
                                    <button className={cx(shared.btn, shared["btn-sm"])} disabled={busy !== null} onClick={() => void action(s, "stop")}>Stop</button>
                                    <button className={cx(shared.btn, shared["btn-sm"], shared["btn-danger"])} disabled={busy !== null} onClick={() => void action(s, "down")}>Down</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </section>
    );
}
