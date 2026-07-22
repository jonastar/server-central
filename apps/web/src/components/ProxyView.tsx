import { useCallback, useEffect, useState } from "react";
import type { ProxyConfig, ProxyRoute, ProxyState, ServerEntry } from "@central/shared";
import { api } from "../api";
import { useConnection } from "../hooks/useConnection";
import type { Route } from "../routes";
import { EmptyState, ErrorBanner, Modal, StatusDot } from "./ui";

const POLL_MS = 5000;

function nodeName(servers: ServerEntry[], nodeId: string): string {
    return servers.find((s) => s.id === nodeId)?.name ?? nodeId;
}

function ConfigModal({ servers, current, onClose, onSaved }: {
    servers: ServerEntry[];
    current: ProxyConfig | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [nodeId, setNodeId] = useState(current?.nodeId ?? servers[0]?.id ?? "");
    const [certMode, setCertMode] = useState<ProxyConfig["certMode"]>(current?.certMode ?? "auto");
    const [acmeEmail, setAcmeEmail] = useState(current?.acmeEmail ?? "");
    const [httpPort, setHttpPort] = useState(current?.httpPort ? String(current.httpPort) : "");
    const [httpsPort, setHttpsPort] = useState(current?.httpsPort ? String(current.httpsPort) : "");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            const config: ProxyConfig = { nodeId, certMode };
            const email = acmeEmail.trim();
            if (email) {
                config.acmeEmail = email;
            }
            if (httpPort.trim()) {
                config.httpPort = Number(httpPort.trim());
            }
            if (httpsPort.trim()) {
                config.httpsPort = Number(httpsPort.trim());
            }
            await api("setProxyConfig", { config });
            onSaved();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title={current ? "Proxy settings" : "Set up reverse proxy"} onClose={onClose} width={480}>
            <form onSubmit={handleSubmit}>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <label className="login-field">
                    <span>Proxy node — runs the Caddy container (ports 80/443)</span>
                    <select className="input" value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
                        {servers.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}{s.status.state !== "online" ? " (offline)" : ""}</option>
                        ))}
                    </select>
                </label>
                <label className="login-field">
                    <span>Certificates</span>
                    <select className="input" value={certMode} onChange={(e) => setCertMode(e.target.value as ProxyConfig["certMode"])}>
                        <option value="auto">Automatic HTTPS (public hostnames, Let's Encrypt)</option>
                        <option value="internal">Internal CA (LAN-only hostnames, self-signed)</option>
                    </select>
                </label>
                {certMode === "auto" && (
                    <label className="login-field">
                        <span>ACME email (optional)</span>
                        <input className="input" type="email" value={acmeEmail} onChange={(e) => setAcmeEmail(e.target.value)} placeholder="you@example.com" />
                    </label>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                    <label className="login-field" style={{ flex: 1 }}>
                        <span>HTTP host port</span>
                        <input className="input" value={httpPort} onChange={(e) => setHttpPort(e.target.value)} placeholder="80" inputMode="numeric" />
                    </label>
                    <label className="login-field" style={{ flex: 1 }}>
                        <span>HTTPS host port</span>
                        <input className="input" value={httpsPort} onChange={(e) => setHttpsPort(e.target.value)} placeholder="443" inputMode="numeric" />
                    </label>
                </div>
                {(httpPort.trim() || httpsPort.trim()) && (
                    <p style={{ fontSize: 12, color: "var(--fg-muted)", margin: "0 0 8px" }}>
                        Non-standard ports: Let's Encrypt (HTTP-01) and HTTP→HTTPS redirects still
                        expect the <em>public</em> side on 80/443 — forward router ports 80/443 to
                        these host ports for external hostnames.
                    </p>
                )}
                <div className="modal-actions" style={{ marginTop: 16 }}>
                    <button className="btn" type="button" onClick={onClose}>Cancel</button>
                    <button className="btn btn-primary" type="submit" disabled={busy || !nodeId}>
                        {busy ? "Saving…" : "Save"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

function RouteModal({ servers, existing, onClose, onSaved }: {
    servers: ServerEntry[];
    existing: ProxyRoute | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [host, setHost] = useState(existing?.host ?? "");
    const [pathPrefix, setPathPrefix] = useState(existing?.pathPrefix ?? "");
    const [nodeId, setNodeId] = useState(existing?.target.nodeId ?? servers[0]?.id ?? "");
    const [port, setPort] = useState(existing ? String(existing.target.port) : "");
    const [scheme, setScheme] = useState<"http" | "https">(existing?.target.scheme ?? "http");
    const [skipVerify, setSkipVerify] = useState(existing?.target.insecureSkipVerify ?? false);
    const [enabled, setEnabled] = useState(existing?.enabled ?? true);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            const prefix = pathPrefix.trim();
            const route: Omit<ProxyRoute, "id"> = {
                host: host.trim().toLowerCase(),
                ...(prefix ? { pathPrefix: prefix } : {}),
                target: {
                    nodeId,
                    port: Number(port),
                    scheme,
                    ...(scheme === "https" && skipVerify ? { insecureSkipVerify: true } : {}),
                },
                enabled,
            };
            if (existing) {
                await api("updateProxyRoute", { route: { ...route, id: existing.id } });
            } else {
                await api("createProxyRoute", { route });
            }
            onSaved();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title={existing ? "Edit route" : "Add route"} onClose={onClose} width={480}>
            <form onSubmit={handleSubmit}>
                {error && <ErrorBanner>{error}</ErrorBanner>}
                <label className="login-field">
                    <span>Hostname</span>
                    <input className="input" autoFocus value={host} onChange={(e) => setHost(e.target.value)} placeholder="jellyfin.example.com" />
                </label>
                <label className="login-field">
                    <span>Path prefix (optional)</span>
                    <input className="input" value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} placeholder="/api" />
                </label>
                <label className="login-field">
                    <span>Target node</span>
                    <select className="input" value={nodeId} onChange={(e) => setNodeId(e.target.value)}>
                        {servers.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}{s.status.state !== "online" ? " (offline)" : ""}</option>
                        ))}
                    </select>
                </label>
                <div style={{ display: "flex", gap: 8 }}>
                    <label className="login-field" style={{ flex: 1 }}>
                        <span>Published host port</span>
                        <input className="input" value={port} onChange={(e) => setPort(e.target.value)} placeholder="8096" inputMode="numeric" />
                    </label>
                    <label className="login-field" style={{ flex: 1 }}>
                        <span>Upstream scheme</span>
                        <select className="input" value={scheme} onChange={(e) => setScheme(e.target.value as "http" | "https")}>
                            <option value="http">http</option>
                            <option value="https">https</option>
                        </select>
                    </label>
                </div>
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
                <div className="modal-actions" style={{ marginTop: 16 }}>
                    <button className="btn" type="button" onClick={onClose}>Cancel</button>
                    <button className="btn btn-primary" type="submit" disabled={busy}>
                        {busy ? "Saving…" : existing ? "Save" : "Add"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}

export function ProxyView({ onNavigate }: { onNavigate: (route: Route) => void }) {
    const { servers } = useConnection();
    const [state, setState] = useState<ProxyState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [editingConfig, setEditingConfig] = useState(false);
    const [routeModal, setRouteModal] = useState<{ existing: ProxyRoute | null } | null>(null);

    const refresh = useCallback(() => {
        api("getProxyState", undefined)
            .then((s) => { setState(s); setError(null); })
            .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    }, []);

    useEffect(() => {
        refresh();
        const timer = setInterval(refresh, POLL_MS);
        return () => clearInterval(timer);
    }, [refresh]);

    async function run(label: string, fn: () => Promise<unknown>) {
        setBusy(label);
        setError(null);
        try {
            await fn();
            refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    }

    const config = state?.config ?? null;
    const container = state?.container ?? null;
    const lastApply = state?.lastApply ?? null;

    return (
        <div className="view">
            <header className="view-header">
                <h1>Reverse proxy</h1>
            </header>

            {error && <ErrorBanner>{error}</ErrorBanner>}

            {state === null ? (
                <EmptyState>Loading…</EmptyState>
            ) : !config ? (
                <div style={{ maxWidth: 520 }}>
                    <p style={{ color: "var(--fg-muted)", fontSize: 13 }}>
                        Server Central deploys and manages a Caddy reverse proxy for HTTP(S)
                        traffic into your apps. Pick a node to run it on to get started.
                    </p>
                    <button className="btn btn-primary" onClick={() => setEditingConfig(true)}>Set up reverse proxy</button>
                </div>
            ) : (
                <>
                    <section className="panel" style={{ padding: 16, marginBottom: 20 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                            <StatusDot
                                state={container?.state === "running" ? "online" : container?.present ? "error" : "offline"}
                                title={container?.status ?? "not deployed"}
                            />
                            <div style={{ flex: 1, minWidth: 240 }}>
                                <div style={{ fontWeight: 600 }}>
                                    Caddy on {nodeName(servers, config.nodeId)}
                                </div>
                                <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                                    {container?.present
                                        ? `${container.status ?? container.state} · ${container.image ?? ""}`
                                        : "Not deployed yet"}
                                    {" · "}certs: {config.certMode === "internal" ? "internal CA" : "automatic HTTPS"}
                                    {" · "}ports {config.httpPort ?? 80}/{config.httpsPort ?? 443}
                                </div>
                                {container?.error && (
                                    <div style={{ fontSize: 12, color: "var(--danger, #e5534b)" }}>
                                        {container.error}
                                    </div>
                                )}
                                {container?.present && (
                                    <button
                                        style={{ fontSize: 12, padding: 0, border: "none", background: "none", color: "var(--accent)", cursor: "pointer" }}
                                        onClick={() => onNavigate({
                                            view: "server",
                                            serverId: config.nodeId,
                                            tab: "docker",
                                            section: "containers",
                                            filter: "sc-proxy",
                                        })}
                                    >
                                        View container in Docker →
                                    </button>
                                )}
                                {lastApply && (
                                    <div style={{ fontSize: 12, color: lastApply.ok ? "var(--fg-muted)" : "var(--danger, #e5534b)" }}>
                                        {lastApply.ok
                                            ? `Config applied ${new Date(lastApply.at).toLocaleString()}`
                                            : `Config apply failed: ${lastApply.error}`}
                                    </div>
                                )}
                            </div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                <button className="btn" disabled={busy !== null} onClick={() => setEditingConfig(true)}>Settings</button>
                                <button
                                    className="btn"
                                    disabled={busy !== null}
                                    onClick={() => void run("apply", () => api("applyProxyConfig", undefined))}
                                >
                                    {busy === "apply" ? "Applying…" : "Apply config"}
                                </button>
                                <button
                                    className="btn btn-primary"
                                    disabled={busy !== null}
                                    onClick={() => void run("deploy", () => api("deployProxy", undefined))}
                                >
                                    {busy === "deploy" ? "Deploying…" : container?.present ? "Redeploy" : "Deploy"}
                                </button>
                                {container?.present && (
                                    <button
                                        className="btn"
                                        disabled={busy !== null}
                                        onClick={() => {
                                            if (confirm("Remove the proxy container? Routed hostnames stop resolving until it's redeployed. Certificates are kept.")) {
                                                void run("remove", () => api("removeProxy", undefined));
                                            }
                                        }}
                                    >
                                        Remove
                                    </button>
                                )}
                            </div>
                        </div>
                    </section>

                    <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
                        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, flex: 1 }}>Routes</h2>
                        <button className="btn btn-primary" onClick={() => setRouteModal({ existing: null })}>Add route</button>
                    </div>

                    {state.routes.length === 0 ? (
                        <EmptyState>No routes yet. Add one to expose an app through the proxy.</EmptyState>
                    ) : (
                        <section className="panel">
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th>Host</th>
                                        <th>Path</th>
                                        <th>Target</th>
                                        <th>Enabled</th>
                                        <th />
                                    </tr>
                                </thead>
                                <tbody>
                                    {state.routes.map((r) => (
                                        <tr key={r.id} style={r.enabled ? undefined : { opacity: 0.55 }}>
                                            <td className="file-name">{r.host}</td>
                                            <td className="mono dim">{r.pathPrefix ?? "/"}</td>
                                            <td className="dim">
                                                {r.target.scheme}://{nodeName(servers, r.target.nodeId)}:{r.target.port}
                                                {r.target.insecureSkipVerify ? " (no verify)" : ""}
                                            </td>
                                            <td className="dim">{r.enabled ? "Yes" : "No"}</td>
                                            <td className="row-actions-always">
                                                <button className="btn" disabled={busy !== null} onClick={() => setRouteModal({ existing: r })}>Edit</button>{" "}
                                                <button
                                                    className="btn"
                                                    disabled={busy !== null}
                                                    onClick={() => {
                                                        if (confirm(`Delete the route for ${r.host}?`)) {
                                                            void run(`delete-${r.id}`, () => api("deleteProxyRoute", { routeId: r.id }));
                                                        }
                                                    }}
                                                >
                                                    Delete
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </section>
                    )}
                </>
            )}

            {editingConfig && (
                <ConfigModal
                    servers={servers}
                    current={config}
                    onClose={() => setEditingConfig(false)}
                    onSaved={refresh}
                />
            )}
            {routeModal && (
                <RouteModal
                    servers={servers}
                    existing={routeModal.existing}
                    onClose={() => setRouteModal(null)}
                    onSaved={refresh}
                />
            )}
        </div>
    );
}
