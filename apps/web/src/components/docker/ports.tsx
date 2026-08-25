import shared from "../../styles/shared.module.css";

/**
 * Published-port pairs out of either shape the docker readers produce: the raw
 * `docker ps` rendering `ContainerInfo.ports` carries ("0.0.0.0:8080->80/tcp,
 * :::8080->80/tcp") or the already-normalized "8080→80" that compose's
 * structured publishers give `ComposeServiceStatus.ports`. The IPv4 and IPv6
 * binds of one mapping collapse to a single pair.
 */
export function portPairs(ports: string): { published: string; target: string }[] {
    const seen = new Map<string, { published: string; target: string }>();
    for (const part of ports.split(",").map((p) => p.trim()).filter(Boolean)) {
        const raw = /:(\d+)->(\d+)/.exec(part);
        const pair = raw
            ? { published: raw[1]!, target: raw[2]! }
            : (() => {
                const [published, target] = part.split("→");
                return { published: (published ?? part).trim(), target: (target ?? "").trim() };
            })();
        seen.set(`${pair.published}→${pair.target}`, pair);
    }
    return [...seen.values()];
}

/** Published ports, linked to the host when we know its address. */
export function PortLinks({ ports, hostIp }: { ports: string | undefined; hostIp: string | undefined }) {
    const pairs = ports ? portPairs(ports) : [];
    if (pairs.length === 0) {
        return <>—</>;
    }
    return (
        <>
            {pairs.map((p, i) => {
                const label = `${p.published}${p.target ? `→${p.target}` : ""}`;
                return (
                    <span key={label} className={shared.mono}>
                        {i > 0 && ", "}
                        {hostIp
                            ? <a href={`http://${hostIp}:${p.published}`} target="_blank" rel="noreferrer">{label}</a>
                            : label}
                    </span>
                );
            })}
        </>
    );
}
