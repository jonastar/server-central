import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { X509Certificate } from "node:crypto";
import { ensureTls } from "../../src/tls";

// The CA model's whole point: the CA agents trust is stable, while the leaf the
// server presents can be re-issued (renewed, or expanded with a new domain/IP SAN)
// without breaking agents — the new leaf still chains to the same CA.

let dir: string;

beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-tls-"));
});

afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

test("re-issuing the leaf for a new domain keeps the CA stable and still chains to it", async () => {
    const first = await ensureTls(dir, { lanIps: ["10.0.0.5"] });
    const firstLeafSan = new X509Certificate(first.certPem).subjectAltName ?? "";
    expect(firstLeafSan).not.toContain("example.test");

    // Add a domain — the leaf must be re-issued to cover it.
    const second = await ensureTls(dir, { lanIps: ["10.0.0.5"], domain: "example.test" });

    // CA is unchanged (agents that embedded it keep working)...
    expect(second.caCertPem).toBe(first.caCertPem);
    // ...but the leaf is a different cert that now carries the domain...
    expect(second.certPem).not.toBe(first.certPem);
    expect(new X509Certificate(second.certPem).subjectAltName ?? "").toContain("example.test");
    // ...and it still chains to the same CA.
    const leaf = new X509Certificate(second.certPem);
    const ca = new X509Certificate(second.caCertPem);
    // checkIssued returns the issuer cert (truthy) when it signed the leaf.
    expect(leaf.checkIssued(ca)).toBeTruthy();
});

test("ensureTls is stable when inputs don't change (no needless re-issue)", async () => {
    const a = await ensureTls(dir, { domain: "example.test", lanIps: ["10.0.0.5"] });
    const b = await ensureTls(dir, { domain: "example.test", lanIps: ["10.0.0.5"] });
    expect(b.certPem).toBe(a.certPem);
});
