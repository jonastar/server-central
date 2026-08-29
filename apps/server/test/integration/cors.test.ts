import { expect, test } from "bun:test";
import { corsHeaders, originAllowsRequest, originOf, resolveAllowedOrigins } from "../../src/cors";

// The allowlist decides whether a browser hands an API response back to a
// cross-origin page. Unconfigured installs must keep the historical wildcard, and
// a configured one must echo (never enumerate) the caller's origin.

test("unconfigured installs keep the wildcard", () => {
    expect(resolveAllowedOrigins([], null)).toEqual([]);
    expect(corsHeaders("https://evil.example", [])["Access-Control-Allow-Origin"]).toBe("*");
});

test("the primary URL's origin is allowed without configuring it twice", () => {
    expect(resolveAllowedOrigins([], "https://sc.example.com")).toEqual(["https://sc.example.com"]);
});

test("a full URL and a bare origin normalize to the same entry", () => {
    expect(resolveAllowedOrigins(["https://app.example.com/", "https://app.example.com"], null))
        .toEqual(["https://app.example.com"]);
});

test("the primary URL isn't duplicated when it's also listed explicitly", () => {
    expect(resolveAllowedOrigins(["https://sc.example.com"], "https://sc.example.com/"))
        .toEqual(["https://sc.example.com"]);
});

test("a listed origin is echoed back, not enumerated", () => {
    const allowed = ["https://a.example.com", "https://b.example.com"];
    const headers = corsHeaders("https://b.example.com", allowed);
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://b.example.com");
    expect(headers.Vary).toBe("Origin");
});

test("an unlisted origin gets no allow header at all", () => {
    const headers = corsHeaders("https://evil.example", ["https://sc.example.com"]);
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    // Vary still matters: a cache mustn't reuse an allowed origin's response here.
    expect(headers.Vary).toBe("Origin");
});

test("a request with no Origin (curl, server-to-server) gets no allow header", () => {
    expect(corsHeaders(null, ["https://sc.example.com"])["Access-Control-Allow-Origin"]).toBeUndefined();
});

test("an explicit * keeps the wildcard even alongside other entries", () => {
    const allowed = resolveAllowedOrigins(["*", "https://sc.example.com"], null);
    expect(corsHeaders("https://anything.example", allowed)["Access-Control-Allow-Origin"]).toBe("*");
});

test("junk entries are dropped rather than allowlisted", () => {
    expect(resolveAllowedOrigins(["", "  ", "not a url"], null)).toEqual([]);
});

test("the method and header allowances are always present", () => {
    for (const allowed of [[], ["https://sc.example.com"]]) {
        const headers = corsHeaders("https://sc.example.com", allowed);
        expect(headers["Access-Control-Allow-Methods"]).toBe("POST, OPTIONS");
        expect(headers["Access-Control-Allow-Headers"]).toBe("Content-Type, Authorization");
    }
});

test("originOf strips path, query and fragment", () => {
    expect(originOf("https://sc.example.com:8443/a/b?c=d#e")).toBe("https://sc.example.com:8443");
});

// The request-level half: CORS headers decide who may read a reply, this decides
// whether a state-changing request is acted on at all. A "simple" cross-origin
// POST (Content-Type: text/plain) reaches the handler with no preflight, so
// without this any page could POST setupOwner at a LAN control plane.

test("a cross-origin page can't reach the API, wildcard CORS or not", () => {
    expect(originAllowsRequest("https://evil.example", ["sc.lan:4141"], [])).toBe(false);
    expect(originAllowsRequest("https://evil.example", ["sc.lan:4141"], ["https://sc.lan"])).toBe(false);
});

test("the UI's own origin is allowed — it's the host the request arrived on", () => {
    expect(originAllowsRequest("http://192.168.1.5:4141", ["192.168.1.5:4141"], [])).toBe(true);
});

test("scheme isn't compared, so a TLS-terminating proxy still works", () => {
    expect(originAllowsRequest("https://sc.example.com", ["sc.example.com"], [])).toBe(true);
});

test("a front end's X-Forwarded-Host counts as the arrival host", () => {
    expect(originAllowsRequest("https://sc.example.com", ["10.0.0.9:4141", "sc.example.com"], [])).toBe(true);
});

test("no Origin at all (curl, another server) is not a browser request to refuse", () => {
    expect(originAllowsRequest(null, ["sc.lan:4141"], [])).toBe(true);
});

test("an allowlisted origin may call cross-origin, and an explicit * opens it up", () => {
    expect(originAllowsRequest("https://app.example.com", ["sc.lan:4141"], ["https://app.example.com"])).toBe(true);
    expect(originAllowsRequest("https://anything.example", ["sc.lan:4141"], ["*"])).toBe(true);
});

test("a null-ish or unparseable Origin never matches a host", () => {
    expect(originAllowsRequest("null", ["sc.lan:4141"], [])).toBe(false);
    expect(originAllowsRequest("https://sc.example.com", [null, ""], [])).toBe(false);
});
