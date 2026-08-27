/**
 * Who the request actually came from, when a reverse proxy sits in front.
 *
 * Every request then arrives from the proxy's own address, which matters more
 * than it looks: sessions would all record the proxy's IP, and — worse — the
 * login throttle in auth.ts keys on this value, so one attacker brute-forcing an
 * account would lock out every user behind the same proxy.
 *
 * `X-Forwarded-For` is trivially spoofable by whoever makes the request, so it's
 * only consulted when the *direct peer* is a configured trusted proxy. With no
 * trusted proxies configured (the default, direct exposure) the header is
 * ignored outright.
 */

/**
 * One trusted proxy as configured: an IP or CIDR, and optionally the header that
 * particular proxy writes the client address into.
 *
 * The per-entry header exists for parallel entry paths — the same control plane
 * reached both through an internal nginx setting `X-Real-IP` and through a CDN
 * tunnel setting `CF-Connecting-IP`, each connecting directly. A single global
 * header forces one of those to silently degrade to the peer address. (It does
 * nothing for *chained* proxies: our peer is only ever the last hop, so only that
 * hop's header is ever ours to read.)
 */
export type TrustedProxyEntry = string | { address: string; header?: string };

/** One parsed IP or CIDR from the trusted-proxy list. */
interface Cidr {
    /** Address bytes — 4 for IPv4, 16 for IPv6. */
    bytes: Uint8Array;
    /** Significant leading bits. A bare IP is a full-width prefix. */
    bits: number;
    /** Header this proxy writes, when it differs from the configured default. */
    header?: string;
}

/**
 * Parse an address into bytes. IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is folded to
 * its 4-byte IPv4 form, because that's how the same client can otherwise appear
 * under two different-looking addresses depending on the listener's socket
 * family — and a trusted-proxy entry written as `10.0.0.1` has to match both.
 */
export function parseIp(text: string): Uint8Array | null {
    const value = text.trim().replace(/^\[|\]$/g, "");
    if (!value) {
        return null;
    }

    if (value.includes(":")) {
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
        if (mapped) {
            return parseIp(mapped[1]);
        }
        return parseIpv6(value);
    }

    const parts = value.split(".");
    if (parts.length !== 4) {
        return null;
    }
    const bytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
        if (!/^\d{1,3}$/.test(parts[i])) {
            return null;
        }
        const n = Number(parts[i]);
        if (n > 255) {
            return null;
        }
        bytes[i] = n;
    }
    return bytes;
}

function parseIpv6(value: string): Uint8Array | null {
    // Split on the "::" run-of-zeros marker; at most one may appear.
    const halves = value.split("::");
    if (halves.length > 2) {
        return null;
    }
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;

    const groups: number[] = [];
    const push = (group: string): boolean => {
        if (!/^[0-9a-f]{1,4}$/i.test(group)) {
            return false;
        }
        groups.push(Number.parseInt(group, 16));
        return true;
    };

    for (const g of head) {
        if (!push(g)) {
            return null;
        }
    }
    if (tail === null) {
        if (groups.length !== 8) {
            return null;
        }
    } else {
        const tailGroups: number[] = [];
        for (const g of tail) {
            if (!/^[0-9a-f]{1,4}$/i.test(g)) {
                return null;
            }
            tailGroups.push(Number.parseInt(g, 16));
        }
        const zeros = 8 - groups.length - tailGroups.length;
        if (zeros < 1) {
            return null;
        }
        for (let i = 0; i < zeros; i++) {
            groups.push(0);
        }
        groups.push(...tailGroups);
    }

    const bytes = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
        bytes[i * 2] = groups[i] >> 8;
        bytes[i * 2 + 1] = groups[i] & 0xff;
    }
    return bytes;
}

/** Parse one trusted-proxy entry: a bare IP, or `address/prefixLength`. */
export function parseCidr(entry: string): Cidr | null {
    const slash = entry.lastIndexOf("/");
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const bytes = parseIp(address);
    if (!bytes) {
        return null;
    }
    const full = bytes.length * 8;
    if (slash === -1) {
        return { bytes, bits: full };
    }
    const bits = Number(entry.slice(slash + 1));
    if (!Number.isInteger(bits) || bits < 0 || bits > full) {
        return null;
    }
    return { bytes, bits };
}

/** Parse a trusted-proxy list, dropping (rather than throwing on) junk entries. */
export function parseTrustedProxies(entries: readonly TrustedProxyEntry[]): Cidr[] {
    const out: Cidr[] = [];
    for (const entry of entries) {
        const address = typeof entry === "string" ? entry : entry.address;
        const header = typeof entry === "string" ? undefined : entry.header?.trim().toLowerCase();
        const cidr = parseCidr(address);
        if (cidr) {
            out.push(header ? { ...cidr, header } : cidr);
        }
    }
    return out;
}

/**
 * Parse the `SC_TRUSTED_PROXIES` env form: comma-separated entries, each an
 * address optionally followed by `=<header>` — "127.0.0.1,10.42.0.0/16=X-Real-IP".
 */
export function parseTrustedProxiesEnv(value: string): TrustedProxyEntry[] {
    const out: TrustedProxyEntry[] = [];
    for (const raw of value.split(",")) {
        const entry = raw.trim();
        if (!entry) {
            continue;
        }
        const eq = entry.indexOf("=");
        out.push(eq === -1
            ? entry
            : { address: entry.slice(0, eq).trim(), header: entry.slice(eq + 1).trim() });
    }
    return out;
}

function inCidr(ip: Uint8Array, cidr: Cidr): boolean {
    if (ip.length !== cidr.bytes.length) {
        return false;
    }
    const wholeBytes = cidr.bits >> 3;
    for (let i = 0; i < wholeBytes; i++) {
        if (ip[i] !== cidr.bytes[i]) {
            return false;
        }
    }
    const rest = cidr.bits & 7;
    if (rest === 0) {
        return true;
    }
    const mask = 0xff << (8 - rest) & 0xff;
    return (ip[wholeBytes] & mask) === (cidr.bytes[wholeBytes] & mask);
}

/** The first trusted entry covering `ip`, or null when none does. */
function matchTrusted(ip: Uint8Array | null, trusted: readonly Cidr[]): Cidr | null {
    if (ip === null) {
        return null;
    }
    return trusted.find((cidr) => inCidr(ip, cidr)) ?? null;
}

function isTrusted(ip: Uint8Array | null, trusted: readonly Cidr[]): boolean {
    return matchTrusted(ip, trusted) !== null;
}

/**
 * Which header to read for a request arriving from `peer`: the one its own
 * trusted-proxy entry names, else the configured default. An untrusted peer gets
 * the default too — its header is ignored downstream regardless.
 */
export function headerForPeer(peer: string | null, trusted: readonly Cidr[], fallback: string): string {
    return matchTrusted(peer ? parseIp(peer) : null, trusted)?.header ?? fallback;
}

/**
 * Canonical text form, so a v4-mapped peer and its plain v4 form record alike.
 * IPv6 gets the usual RFC 5952 treatment — lowercase hex, no leading zeros, and
 * the longest run of zero groups collapsed to "::" — because this string is what
 * ends up in session records and audit output, where "2001:db8::1" is readable
 * and "2001:db8:0:0:0:0:0:1" is not.
 */
function format(bytes: Uint8Array): string {
    if (bytes.length === 4) {
        return bytes.join(".");
    }
    const groups: number[] = [];
    for (let i = 0; i < 8; i++) {
        groups.push((bytes[i * 2] << 8) | bytes[i * 2 + 1]);
    }

    // Longest zero run, earliest on a tie. Runs of one are left alone: "::" must
    // stand for two or more groups to be shorter than what it replaces.
    let bestStart = -1;
    let bestLen = 0;
    for (let i = 0; i < 8; i++) {
        if (groups[i] !== 0) {
            continue;
        }
        let j = i;
        while (j < 8 && groups[j] === 0) {
            j++;
        }
        if (j - i > bestLen) {
            bestStart = i;
            bestLen = j - i;
        }
        i = j - 1;
    }

    const hex = groups.map((g) => g.toString(16));
    if (bestLen < 2) {
        return hex.join(":");
    }
    return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
}

/** Header consulted when none is configured — the de facto standard. */
export const DEFAULT_FORWARDED_HEADER = "x-forwarded-for";

/**
 * Drop a trailing port, which RFC 7239 permits and some proxies emit on
 * `X-Forwarded-For` too. Written so a bare IPv6 literal (all colons, no port)
 * survives untouched: only a bracketed form or a single-colon IPv4 is stripped.
 */
function stripPort(value: string): string {
    const trimmed = value.trim();
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(trimmed);
    if (bracketed) {
        return bracketed[1];
    }
    const parts = trimmed.split(":");
    return parts.length === 2 && /^\d+$/.test(parts[1]) ? parts[0] : trimmed;
}

/**
 * The addresses a forwarded header carries, oldest (furthest from us) first.
 *
 * Two syntaxes, chosen by header name. RFC 7239 `Forwarded` is a list of
 * semicolon-separated parameter sets — `for=192.0.2.60;proto=https, for="[2001:db8::1]"`
 * — so only the `for=` parameter is of interest, and its value may be quoted and
 * bracketed. Everything else (`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`,
 * `True-Client-IP`, …) is a plain comma-separated list.
 *
 * Single-address headers like `X-Real-IP` need no special case: they parse as a
 * one-element chain, and the walk below handles that correctly.
 */
export function parseForwardedChain(headerName: string, value: string): string[] {
    if (headerName.trim().toLowerCase() !== "forwarded") {
        return value.split(",").map(stripPort);
    }
    const out: string[] = [];
    for (const element of value.split(",")) {
        for (const param of element.split(";")) {
            const eq = param.indexOf("=");
            if (eq === -1 || param.slice(0, eq).trim().toLowerCase() !== "for") {
                continue;
            }
            // for="[2001:db8::1]:443" — quotes first, then the port/brackets.
            out.push(stripPort(param.slice(eq + 1).trim().replace(/^"|"$/g, "")));
        }
    }
    return out;
}

/**
 * The client address to attribute a request to.
 *
 * With no trusted proxies configured, that's always the direct peer. Otherwise
 * the forwarded chain is walked **right to left** — the rightmost entry is the
 * one appended by the nearest (trusted) proxy, and everything further left was
 * supplied by something upstream of it. The first entry that isn't itself a
 * trusted proxy is the furthest point in the chain we still have grounds to
 * believe; anything beyond it is attacker-controlled. If the whole chain is
 * trusted proxies, or none of it parses, we fall back to the peer.
 */
export function resolveClientIp(
    peer: string | null,
    forwardedValue: string | null,
    trusted: readonly Cidr[],
    headerName: string = DEFAULT_FORWARDED_HEADER,
): string | null {
    const peerBytes = peer ? parseIp(peer) : null;
    const peerText = peerBytes ? format(peerBytes) : peer;

    if (trusted.length === 0 || !forwardedValue || !isTrusted(peerBytes, trusted)) {
        return peerText;
    }

    const chain = parseForwardedChain(headerName, forwardedValue);
    for (let i = chain.length - 1; i >= 0; i--) {
        const bytes = parseIp(chain[i]);
        if (!bytes) {
            continue;
        }
        if (!isTrusted(bytes, trusted)) {
            return format(bytes);
        }
    }
    return peerText;
}
