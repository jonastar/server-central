import { expect, test } from "bun:test";
import { corsHeaders, originOf, resolveAllowedOrigins } from "../../src/cors";

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
