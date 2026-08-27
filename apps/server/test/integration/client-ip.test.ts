import { expect, test } from "bun:test";
import { headerForPeer, parseForwardedChain, parseTrustedProxies, parseTrustedProxiesEnv, resolveClientIp } from "../../src/client-ip";

// Behind a reverse proxy every request arrives from the proxy's own address, and
// the login throttle in auth.ts keys on the value resolved here — so getting this
// wrong either locks out every user behind a shared proxy (trusting nothing) or
// lets any caller forge an identity by sending a header (trusting everything).
// These pin both edges.

const LOCAL = parseTrustedProxies(["127.0.0.1", "::1"]);
const LAN = parseTrustedProxies(["10.42.0.0/16"]);

test("with no trusted proxies configured, X-Forwarded-For is ignored", () => {
    expect(resolveClientIp("203.0.113.9", "1.2.3.4", [])).toBe("203.0.113.9");
});

test("a header from an untrusted peer is ignored", () => {
    expect(resolveClientIp("203.0.113.9", "1.2.3.4", LOCAL)).toBe("203.0.113.9");
});

test("a header from a trusted peer names the client", () => {
    expect(resolveClientIp("127.0.0.1", "203.0.113.9", LOCAL)).toBe("203.0.113.9");
});

test("the rightmost untrusted hop wins, so a forged prefix can't shadow it", () => {
    // The client sent "1.2.3.4" itself; two trusted proxies appended the truth.
    const xff = "1.2.3.4, 203.0.113.9, 10.42.0.7";
    expect(resolveClientIp("127.0.0.1", xff, parseTrustedProxies(["127.0.0.1", "10.42.0.0/16"])))
        .toBe("203.0.113.9");
});

test("an all-trusted chain falls back to the peer rather than a proxy address", () => {
    expect(resolveClientIp("10.42.0.1", "10.42.0.7", LAN)).toBe("10.42.0.1");
});

test("IPv4-mapped IPv6 matches its plain IPv4 trusted-proxy entry", () => {
    expect(resolveClientIp("::ffff:127.0.0.1", "203.0.113.9", LOCAL)).toBe("203.0.113.9");
});

test("a v4-mapped peer is recorded in its plain v4 form", () => {
    expect(resolveClientIp("::ffff:203.0.113.9", null, LOCAL)).toBe("203.0.113.9");
});

test("IPv6 peers and CIDRs match on prefix", () => {
    const trusted = parseTrustedProxies(["2001:db8::/32"]);
    expect(resolveClientIp("2001:db8:1::1", "203.0.113.9", trusted)).toBe("203.0.113.9");
    expect(resolveClientIp("2001:dba::1", "203.0.113.9", trusted)).toBe("2001:dba::1");
});

test("unparsable chain entries are skipped, not treated as the client", () => {
    expect(resolveClientIp("127.0.0.1", "203.0.113.9, unknown", LOCAL)).toBe("203.0.113.9");
});

test("junk trusted-proxy entries are dropped rather than throwing", () => {
    expect(parseTrustedProxies(["", "nonsense", "10.0.0.0/99", "10.0.0.0/8"])).toHaveLength(1);
});

// --- Header variations -------------------------------------------------------
//
// Proxies disagree on how to pass the client address: a comma-separated chain
// (X-Forwarded-For), a single value (X-Real-IP, CF-Connecting-IP), or RFC 7239's
// `for=` parameter syntax. The header is named in config; these pin each shape.

test("X-Real-IP's single address is honoured like a one-element chain", () => {
    expect(resolveClientIp("127.0.0.1", "203.0.113.9", LOCAL, "x-real-ip")).toBe("203.0.113.9");
});

test("CF-Connecting-IP works the same way", () => {
    expect(resolveClientIp("127.0.0.1", "203.0.113.9", LOCAL, "cf-connecting-ip")).toBe("203.0.113.9");
});

test("RFC 7239 Forwarded is parsed by its for= parameter, not as a plain list", () => {
    const value = 'for=203.0.113.9;proto=https;by=10.42.0.7';
    expect(resolveClientIp("127.0.0.1", value, LOCAL, "forwarded")).toBe("203.0.113.9");
    // Read as a plain list the whole element would fail to parse and fall back.
    expect(resolveClientIp("127.0.0.1", value, LOCAL, "x-forwarded-for")).toBe("127.0.0.1");
});

test("a Forwarded chain still resolves to the rightmost untrusted hop", () => {
    const value = 'for=1.2.3.4, for=203.0.113.9, for=10.42.0.7';
    const trusted = parseTrustedProxies(["127.0.0.1", "10.42.0.0/16"]);
    expect(resolveClientIp("127.0.0.1", value, trusted, "forwarded")).toBe("203.0.113.9");
});

test("Forwarded's quoted, bracketed IPv6 form is unwrapped", () => {
    expect(parseForwardedChain("forwarded", 'for="[2001:db8::1]:4711"')).toEqual(["2001:db8::1"]);
    expect(resolveClientIp("127.0.0.1", 'for="[2001:db8::1]"', LOCAL, "forwarded")).toBe("2001:db8::1");
});

test("a trailing port is dropped, but a bare IPv6 literal is left intact", () => {
    expect(parseForwardedChain("x-forwarded-for", "192.0.2.60:8443")).toEqual(["192.0.2.60"]);
    expect(parseForwardedChain("x-forwarded-for", "2001:db8::1")).toEqual(["2001:db8::1"]);
    expect(resolveClientIp("127.0.0.1", "2001:db8::1", LOCAL)).toBe("2001:db8::1");
});

test("the header name is matched case-insensitively", () => {
    expect(parseForwardedChain("Forwarded", "for=203.0.113.9")).toEqual(["203.0.113.9"]);
    expect(parseForwardedChain("FORWARDED", "For=203.0.113.9")).toEqual(["203.0.113.9"]);
});

test("Forwarded elements without a for= parameter are ignored", () => {
    expect(parseForwardedChain("forwarded", "proto=https;by=10.0.0.1")).toEqual([]);
});

// --- Per-proxy headers -------------------------------------------------------
//
// One control plane can sit behind two front ends at once — an internal nginx
// writing X-Real-IP and a CDN tunnel writing CF-Connecting-IP, each connecting
// directly. A single global header would silently degrade one of them to the peer
// address, so the header is resolved from whichever entry matches the peer.

const PARALLEL = parseTrustedProxies([
    { address: "127.0.0.1", header: "x-real-ip" },
    { address: "10.42.0.0/16", header: "cf-connecting-ip" },
    "192.168.0.0/16",
]);

test("each proxy's own header is used", () => {
    expect(headerForPeer("127.0.0.1", PARALLEL, "x-forwarded-for")).toBe("x-real-ip");
    expect(headerForPeer("10.42.0.7", PARALLEL, "x-forwarded-for")).toBe("cf-connecting-ip");
});

test("an entry with no header of its own falls back to the default", () => {
    expect(headerForPeer("192.168.1.5", PARALLEL, "x-forwarded-for")).toBe("x-forwarded-for");
});

test("an untrusted peer gets the default (its header is ignored anyway)", () => {
    expect(headerForPeer("203.0.113.9", PARALLEL, "x-forwarded-for")).toBe("x-forwarded-for");
    expect(resolveClientIp("203.0.113.9", "1.2.3.4", PARALLEL, "x-real-ip")).toBe("203.0.113.9");
});

test("two front ends writing different headers both resolve", () => {
    const viaNginx = headerForPeer("127.0.0.1", PARALLEL, "x-forwarded-for");
    expect(resolveClientIp("127.0.0.1", "198.51.100.5", PARALLEL, viaNginx)).toBe("198.51.100.5");
    const viaCdn = headerForPeer("10.42.0.7", PARALLEL, "x-forwarded-for");
    expect(resolveClientIp("10.42.0.7", "198.51.100.9", PARALLEL, viaCdn)).toBe("198.51.100.9");
});

test("the first matching entry wins when ranges overlap", () => {
    const overlapping = parseTrustedProxies([
        { address: "10.42.0.7", header: "x-real-ip" },
        { address: "10.42.0.0/16", header: "cf-connecting-ip" },
    ]);
    expect(headerForPeer("10.42.0.7", overlapping, "x-forwarded-for")).toBe("x-real-ip");
    expect(headerForPeer("10.42.9.9", overlapping, "x-forwarded-for")).toBe("cf-connecting-ip");
});

test("the env form parses bare entries and address=header alike", () => {
    expect(parseTrustedProxiesEnv("127.0.0.1, 10.42.0.0/16=X-Real-IP , ")).toEqual([
        "127.0.0.1",
        { address: "10.42.0.0/16", header: "X-Real-IP" },
    ]);
});

test("env header names are matched case-insensitively once parsed", () => {
    const trusted = parseTrustedProxies(parseTrustedProxiesEnv("127.0.0.1=X-Real-IP"));
    expect(headerForPeer("127.0.0.1", trusted, "x-forwarded-for")).toBe("x-real-ip");
});
