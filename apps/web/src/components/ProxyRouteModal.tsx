import { useEffect, useMemo, useState } from "react";
import type { ComposeStack, ProxyRoute, ProxyRouteTarget, ServerEntry } from "@central/shared";
import { PROXY_NETWORK, proxyNetworkAlias } from "@central/shared";
import { api } from "../api";
import { runTaskAndWait } from "../taskRun";
import { cx } from "../utils";
import {
    attachToProxyNetwork,
    getServiceField,
    listServiceNames,
    parseCompose,
    type ProxyPortCandidate,
    serviceProxyAlias,
    serviceProxyPorts,
    stringifyCompose,
    withImagePorts,
} from "../lib/composeDoc";
import { ErrorBanner, Modal } from "./ui";
import shared from "../styles/shared.module.css";

// Add/edit a route. The target is picked as Node → Stack → Service → Port,
// with the compose file supplying the port list, and the target *kind* follows
// from where the stack lives rather than being a choice: on the proxy node the
// service is dialed over the proxy network (no host port involved — attached on
// save if it isn't yet), anywhere else it's the port the service publishes on
// its host. "Manual host port" stays for anything SC doesn't manage as a stack.
// Design: doc/idea_reverse_proxy.md, v2 layers 4–5.

const MANUAL = "";
const CUSTOM_PORT = "custom";

/** Where a route was opened from — the stack page pre-selects its own service. */
export interface RoutePreset {
    stack: ComposeStack;
    service: string;
}

interface ComposeInfo {
    services: string[];
    /** Per service: what it listens on, and its current alias on the proxy
     *  network (null = not attached). */
    ports: Record<string, ProxyPortCandidate[]>;
    alias: Record<string, string | null>;
    /** The service's `image:`, for asking the host what it EXPOSEs. */
    image: Record<string, string | undefined>;
    text: string;
}

function readCompose(text: string): ComposeInfo {
    const doc = parseCompose(text);
    const services = listServiceNames(doc);
    const info: ComposeInfo = { services, ports: {}, alias: {}, image: {}, text };
    for (const s of services) {
        info.ports[s] = serviceProxyPorts(doc, s);
        info.alias[s] = serviceProxyAlias(doc, s);
        const image = getServiceField<unknown>(doc, s, "image");
        info.image[s] = typeof image === "string" ? image : undefined;
    }
    return info;
}

function nodeName(servers: ServerEntry[], nodeId: string): string {
    return servers.find((s) => s.id === nodeId)?.name ?? nodeId;
}

export function ProxyRouteModal({ servers, proxyNodeId, existing, preset, onClose, onSaved }: {
    servers: ServerEntry[];
    /** The configured proxy node, which decides which stacks get container targets. */
    proxyNodeId: string | null;
    existing: ProxyRoute | null;
    preset?: RoutePreset;
    onClose: () => void;
    onSaved: () => void;
}) {
    const initialTarget = existing?.target;
    const [host, setHost] = useState(existing?.host ?? "");
    const [pathPrefix, setPathPrefix] = useState(existing?.pathPrefix ?? "");
    const [nodeId, setNodeId] = useState(preset?.stack.hostId ?? initialTarget?.nodeId ?? proxyNodeId ?? servers[0]?.id ?? "");
    const [stackId, setStackId] = useState(preset?.stack.id ?? (initialTarget?.kind === "container" ? initialTarget.stackId : MANUAL));
    const [service, setService] = useState(preset?.service ?? (initialTarget?.kind === "container" ? initialTarget.service : ""));
    // The port select's value: a candidate port, or CUSTOM_PORT with the typed
    // one in `customPort`. An existing route's port starts as a candidate and
    // falls back to custom once the compose file says it isn't one.
    const [portChoice, setPortChoice] = useState(initialTarget ? String(initialTarget.port) : "");
    const [customPort, setCustomPort] = useState(initialTarget ? String(initialTarget.port) : "");
    const [scheme, setScheme] = useState<"http" | "https">(initialTarget?.scheme ?? "http");
    const [skipVerify, setSkipVerify] = useState(initialTarget?.insecureSkipVerify ?? false);
    const [enabled, setEnabled] = useState(existing?.enabled ?? true);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);

    const [stacks, setStacks] = useState<ComposeStack[] | null>(null);
    const [compose, setCompose] = useState<ComposeInfo | null>(null);
    const [composeError, setComposeError] = useState<string | null>(null);

    useEffect(() => {
        api("compose", "list", undefined)
            .then(setStacks)
            .catch((err) => { setStacks([]); setError(err instanceof Error ? err.message : String(err)); });
    }, []);

    const nodeStacks = useMemo(() => (stacks ?? []).filter((s) => s.hostId === nodeId), [stacks, nodeId]);
    const stack = nodeStacks.find((s) => s.id === stackId) ?? null;
    const containerKind = stack !== null && nodeId === proxyNodeId;

    // The compose file is the source of the service and port lists.
    useEffect(() => {
        if (!stack) {
            setCompose(null);
            setComposeError(null);
            return;
        }
        let cancelled = false;
        setCompose(null);
        setComposeError(null);
        api("files", "read", { serverId: stack.hostId, path: `${stack.dir}/${stack.composeFile}` })
            .then((file) => {
                if (!cancelled) {
                    setCompose(readCompose(file.content));
                }
            })
            .catch((err) => {
                if (!cancelled) {
                    setComposeError(err instanceof Error ? err.message : String(err));
                }
            });
        return () => { cancelled = true; };
    }, [stack?.id, stack?.hostId, stack?.dir, stack?.composeFile]);

    // Keep the dependent selections valid as the ones above them change.
    useEffect(() => {
        if (compose && !compose.services.includes(service)) {
            setService(compose.services[0] ?? "");
        }
    }, [compose, service]);

    // What the image itself EXPOSEs — the only port list a service with no
    // `ports:` at all has, which on the proxy network is the normal case. A
    // single inspect on the host; absent (image not pulled yet, or `image:` is
    // an unexpanded variable) it just contributes nothing.
    const [imagePorts, setImagePorts] = useState<{ port: number; protocol: "tcp" | "udp" }[]>([]);
    const image = compose?.image[service];
    useEffect(() => {
        setImagePorts([]);
        if (!stack || !containerKind || !image || image.includes("$")) {
            return;
        }
        let cancelled = false;
        api("docker", "imageDefaults", { serverId: stack.hostId, image })
            .then((d) => { if (!cancelled) setImagePorts(d.ports); })
            .catch(() => { /* a suggestion source, not a requirement */ });
        return () => { cancelled = true; };
    }, [stack?.hostId, containerKind, image]);

    const candidates = useMemo(() => {
        const declared = compose?.ports[service] ?? [];
        // Off the proxy node only a published port is reachable.
        return containerKind ? withImagePorts(declared, imagePorts) : declared.filter((c) => c.published);
    }, [compose, service, containerKind, imagePorts]);

    useEffect(() => {
        if (!stack || !compose) {
            return;
        }
        const values = candidates.map((c) => (containerKind ? String(c.port) : c.published!));
        if (portChoice !== CUSTOM_PORT && !values.includes(portChoice)) {
            // A pre-filled port the compose file doesn't declare stays, as the
            // custom entry; a cleared one (stack or service just changed) takes
            // the first candidate.
            if (portChoice) {
                setCustomPort(portChoice);
                setPortChoice(CUSTOM_PORT);
            } else {
                setPortChoice(values[0] ?? CUSTOM_PORT);
            }
        }
    }, [stack, compose, candidates, containerKind, portChoice]);

    // A container route whose stack has since been unregistered can't be
    // re-saved as one — say so, rather than quietly turning it into a
    // host-port route on the way through the form.
    useEffect(() => {
        if (stacks && stackId !== MANUAL && !stacks.some((s) => s.id === stackId)) {
            setStackId(MANUAL);
            setError("The stack this route targeted is no longer registered. Saving now makes it a manual host-port route.");
        }
    }, [stacks, stackId]);

    const port = stack ? (portChoice === CUSTOM_PORT ? customPort : portChoice) : customPort;
    const alias = stack && service ? proxyNetworkAlias(stack.project, service) : "";
    const currentAlias = compose && service ? compose.alias[service] : null;
    const needsAttach = containerKind && compose !== null && service !== "" && currentAlias !== alias;

    function buildTarget(): ProxyRouteTarget {
        const tls = scheme === "https" && skipVerify ? { insecureSkipVerify: true } : {};
        if (stack && containerKind) {
            return { kind: "container", nodeId, stackId: stack.id, service, alias, port: Number(port), scheme, ...tls };
        }
        return { kind: "hostPort", nodeId, port: Number(port), scheme, ...tls };
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        try {
            if (stack && (!compose || !service)) {
                throw new Error("Pick a service");
            }
            if (!/^\d+$/.test(port)) {
                throw new Error("Enter a port number");
            }
            const target = buildTarget();

            // Attach first, route second: the route's first apply then finds the
            // alias already answering. A failed `compose up` leaves no route
            // behind pointing at nothing.
            if (needsAttach && stack && compose) {
                setBusy("Attaching to the proxy network…");
                const doc = parseCompose(compose.text);
                attachToProxyNetwork(doc, service, alias);
                const composePath = `${stack.dir}/${stack.composeFile}`;
                await api("files", "write", { serverId: stack.hostId, path: composePath, content: stringifyCompose(doc) });
                await runTaskAndWait(
                    { kind: "docker_compose_action", stackId: stack.id, action: "up", service },
                    stack.hostId,
                    { feedback: "progress" },
                );
            }

            setBusy("Saving…");
            const prefix = pathPrefix.trim();
            const route: Omit<ProxyRoute, "id"> = {
                host: host.trim().toLowerCase(),
                ...(prefix ? { pathPrefix: prefix } : {}),
                target,
                enabled,
            };
            if (existing) {
                await api("proxy", "updateRoute", { route: { ...route, id: existing.id } });
            } else {
                await api("proxy", "createRoute", { route });
            }
            onSaved();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    }

    const candidateLabel = (c: ProxyPortCandidate) => {
        const name = c.name ? `${c.name} — ` : "";
        if (containerKind) {
            const note = c.published ? ` (also published on host :${c.published})`
                : c.source === "expose" ? " (expose)"
                    : c.source === "image" ? " (image EXPOSE)"
                        : "";
            return `${name}${c.port}${note}`;
        }
        return `${name}host :${c.published} → container :${c.port}`;
    };

    return (
        <Modal title={existing ? "Edit route" : "Add route"} onClose={onClose} width={520}>
            <form onSubmit={handleSubmit}>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <label className={shared["login-field"]}>
                    <span>Hostname</span>
                    <input autoFocus value={host} onChange={(e) => setHost(e.target.value)} placeholder="jellyfin.example.com" />
                </label>
                <label className={shared["login-field"]}>
                    <span>Path prefix (optional)</span>
                    <input value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} placeholder="/api" />
                </label>

                <label className={shared["login-field"]}>
                    <span>Node</span>
                    <select value={nodeId} onChange={(e) => { setNodeId(e.target.value); setStackId(MANUAL); }}>
                        {servers.map((s) => (
                            <option key={s.id} value={s.id}>
                                {s.name}{s.id === proxyNodeId ? " (proxy node)" : ""}{s.status.state !== "online" ? " (offline)" : ""}
                            </option>
                        ))}
                    </select>
                </label>

                <label className={shared["login-field"]}>
                    <span>Stack</span>
                    <select value={stackId} onChange={(e) => { setStackId(e.target.value); setService(""); setPortChoice(""); }} disabled={stacks === null}>
                        <option value={MANUAL}>Manual host port</option>
                        {nodeStacks.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                    </select>
                </label>

                {stack && (
                    <>
                        <label className={shared["login-field"]}>
                            <span>Service</span>
                            <select value={service} onChange={(e) => { setService(e.target.value); setPortChoice(""); }} disabled={!compose}>
                                {!compose && <option value="">{composeError ? "Couldn't read compose file" : "Loading…"}</option>}
                                {compose?.services.map((s) => <option key={s} value={s}>{s}</option>)}
                            </select>
                        </label>
                        {composeError && <ErrorBanner>{composeError}</ErrorBanner>}
                    </>
                )}

                <div style={{ display: "flex", gap: 8 }}>
                    {stack ? (
                        <label className={shared["login-field"]} style={{ flex: 1 }}>
                            <span>{containerKind ? "Container port" : "Published host port"}</span>
                            <select value={portChoice} onChange={(e) => setPortChoice(e.target.value)} disabled={!compose}>
                                {candidates.map((c) => {
                                    const value = containerKind ? String(c.port) : c.published!;
                                    return <option key={value} value={value}>{candidateLabel(c)}</option>;
                                })}
                                <option value={CUSTOM_PORT}>Custom port…</option>
                            </select>
                        </label>
                    ) : (
                        <label className={shared["login-field"]} style={{ flex: 1 }}>
                            <span>Published host port</span>
                            <input value={customPort} onChange={(e) => setCustomPort(e.target.value)} placeholder="8096" inputMode="numeric" />
                        </label>
                    )}
                    <label className={shared["login-field"]} style={{ flex: 1 }}>
                        <span>Upstream scheme</span>
                        <select value={scheme} onChange={(e) => setScheme(e.target.value as "http" | "https")}>
                            <option value="http">http</option>
                            <option value="https">https</option>
                        </select>
                    </label>
                </div>
                {stack && portChoice === CUSTOM_PORT && (
                    <label className={shared["login-field"]}>
                        <span>{containerKind ? "Container port" : "Published host port"}</span>
                        <input autoFocus value={customPort} onChange={(e) => setCustomPort(e.target.value)} placeholder="8096" inputMode="numeric" />
                    </label>
                )}

                {stack && compose && service && (
                    <p className={shared.dim} style={{ fontSize: 12, marginTop: -4, marginBottom: 12 }}>
                        {containerKind
                            ? needsAttach
                                ? <>
                                    On save, <code>{service}</code> is attached to the <code>{PROXY_NETWORK}</code> network as{" "}
                                    <code>{alias}</code> — this edits <code>{stack.composeFile}</code> and runs <code>compose up {service}</code>.
                                    The port needs no <code>ports:</code> entry: the proxy reaches it over the network.
                                </>
                                : <>Reached over the <code>{PROXY_NETWORK}</code> network as <code>{alias}</code>; no host port involved.</>
                            : <>
                                {nodeName(servers, nodeId)} isn't the proxy node, so the proxy reaches this service through the port it
                                publishes on its host{candidates.length === 0 ? " — and it publishes none. Add a ports: entry, or move the route to the proxy node." : "."}
                            </>}
                    </p>
                )}

                {scheme === "https" && (
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 12 }}>
                        <input type="checkbox" checked={skipVerify} onChange={(e) => setSkipVerify(e.target.checked)} />
                        Skip upstream TLS verification (self-signed upstream cert)
                    </label>
                )}
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                    <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                    Enabled
                </label>
                <div className={shared["modal-actions"]}>
                    <button className={shared.btn} type="button" onClick={onClose} disabled={busy !== null}>Cancel</button>
                    <button className={cx(shared.btn, shared["btn-primary"])} type="submit" disabled={busy !== null || !host.trim() || !nodeId}>
                        {busy ?? (existing ? "Save" : "Add route")}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
