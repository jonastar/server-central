import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { X509Certificate, createHash } from "node:crypto";
import { CONTROL_PLANE_TLS_SERVERNAME } from "@central/shared";

export interface TlsBundle {
    /** Leaf cert + key the node server presents to agents. */
    certPath: string;
    keyPath: string;
    certPem: string;
    keyPem: string;
    /**
     * CA cert agents embed as their TLS trust anchor. Agents trust *this*, never
     * the leaf, so the leaf can be re-issued (renewed, or expanded with a new
     * domain/IP SAN) without re-enrolling anything — the new leaf still chains to
     * the same CA. The CA private key never leaves the control plane.
     */
    caCertPath: string;
    caCertPem: string;
    /** sha256//<base64> SPKI pin of the *leaf*, for the one-time pinned download
     *  in the install command (fresh each install, so leaf rotation is moot). */
    pin: string;
}

/** Hosts the leaf cert is valid for. control-plane/localhost/127.0.0.1 are always
 *  included; the rest come from the running control plane so agents can verify the
 *  address they actually connect to (LAN IP, WAN IP, or configured domain). */
export interface SanInputs {
    domain?: string | null;
    wanIp?: string | null;
    lanIps?: string[];
}

const CA_DAYS = 3650;
const LEAF_DAYS = 397;
/** Re-issue the leaf when it has fewer than this many days left. */
const LEAF_RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;

/** All non-internal IPv4 addresses of this host. */
export function localIps(): string[] {
    const out: string[] = [];
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces ?? []) {
            if (!iface.internal && iface.family === "IPv4") {
                out.push(iface.address);
            }
        }
    }
    return out;
}

function computePin(certPem: string): string {
    const spkiDer = new X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" });
    return "sha256//" + createHash("sha256").update(spkiDer).digest("base64");
}

/** Build the leaf SAN as ordered, de-duplicated `TYPE:value` entries. */
function buildSanEntries(inputs: SanInputs): string[] {
    const dns = [CONTROL_PLANE_TLS_SERVERNAME, "localhost"];
    const ip = ["127.0.0.1", ...(inputs.lanIps ?? [])];
    if (inputs.wanIp) {
        ip.push(inputs.wanIp);
    }
    if (inputs.domain) {
        dns.push(inputs.domain);
    }
    const entries = [...dns.map((d) => `DNS:${d}`), ...ip.map((a) => `IP:${a}`)];
    return [...new Set(entries)];
}

/** Normalized set string for comparing a desired SAN against an existing cert's. */
function sanKey(entries: string[]): string {
    return [...entries].sort().join(",");
}

/** Parse an X509's subjectAltName into our `TYPE:value` form (node prints IPs as
 *  "IP Address:"), so it can be compared against buildSanEntries(). */
function certSanEntries(certPem: string): string[] {
    const raw = new X509Certificate(certPem).subjectAltName ?? "";
    if (!raw) {
        return [];
    }
    return raw.split(",").map((part) => part.trim().replace(/^IP Address:/, "IP:")).filter(Boolean);
}

async function runOpenssl(args: string[]): Promise<void> {
    const proc = Bun.spawn(["openssl", ...args], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) {
        const errText = await new Response(proc.stderr).text();
        throw new Error(`openssl ${args[0]} failed (code ${code}): ${errText}`);
    }
}

async function fileExists(p: string): Promise<boolean> {
    return fs.access(p).then(() => true).catch(() => false);
}

/** Generate the long-lived CA once; reuse it forever after. */
async function ensureCa(dir: string): Promise<{ caCertPath: string; caKeyPath: string; caCertPem: string }> {
    const caCertPath = path.join(dir, "ca.crt");
    const caKeyPath = path.join(dir, "ca.key");

    if (!(await fileExists(caCertPath)) || !(await fileExists(caKeyPath))) {
        await runOpenssl([
            "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
            "-keyout", caKeyPath, "-out", caCertPath, "-days", String(CA_DAYS), "-nodes",
            "-subj", "/CN=Server Central Root CA",
            "-addext", "basicConstraints=critical,CA:TRUE",
            "-addext", "keyUsage=critical,keyCertSign,cRLSign",
        ]);
        console.log("Generated Server Central CA at", caCertPath);
    }

    return { caCertPath, caKeyPath, caCertPem: await fs.readFile(caCertPath, "utf8") };
}

/** Whether the existing leaf is still good for `desired` (right SANs, chains to the
 *  current CA, and not near expiry). */
function leafIsCurrent(leafPem: string, caCertPem: string, desired: string[]): boolean {
    try {
        const leaf = new X509Certificate(leafPem);
        if (!leaf.checkIssued(new X509Certificate(caCertPem))) {
            return false;
        }
        if (Date.parse(leaf.validTo) - Date.now() < LEAF_RENEW_BEFORE_MS) {
            return false;
        }
        return sanKey(certSanEntries(leafPem)) === sanKey(desired);
    } catch {
        return false;
    }
}

/** Issue (or re-issue) the leaf cert signed by the CA, covering `inputs`' hosts. */
async function ensureLeaf(
    dir: string,
    ca: { caCertPath: string; caKeyPath: string; caCertPem: string },
    inputs: SanInputs,
): Promise<{ certPath: string; keyPath: string; certPem: string; keyPem: string }> {
    const certPath = path.join(dir, "server.crt");
    const keyPath = path.join(dir, "server.key");
    const desired = buildSanEntries(inputs);

    const haveLeaf = (await fileExists(certPath)) && (await fileExists(keyPath));
    const current = haveLeaf && leafIsCurrent(await fs.readFile(certPath, "utf8"), ca.caCertPem, desired);

    if (!current) {
        const csrPath = path.join(dir, "server.csr");
        const extPath = path.join(dir, "server.ext");
        await fs.writeFile(extPath, `subjectAltName=${desired.join(",")}\nbasicConstraints=CA:FALSE\n`);
        await runOpenssl([
            "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
            "-keyout", keyPath, "-out", csrPath, "-nodes", "-subj", `/CN=${CONTROL_PLANE_TLS_SERVERNAME}`,
        ]);
        await runOpenssl([
            "x509", "-req", "-in", csrPath,
            "-CA", ca.caCertPath, "-CAkey", ca.caKeyPath, "-CAcreateserial",
            "-out", certPath, "-days", String(LEAF_DAYS), "-extfile", extPath,
        ]);
        await fs.rm(csrPath, { force: true });
        await fs.rm(extPath, { force: true });
        console.log(`Issued control-plane leaf cert for [${desired.join(", ")}]`);
    }

    return {
        certPath, keyPath,
        certPem: await fs.readFile(certPath, "utf8"),
        keyPem: await fs.readFile(keyPath, "utf8"),
    };
}

/**
 * Ensure a CA + a leaf cert valid for the given hosts. The CA is the agents' stable
 * trust anchor; the leaf is what the node server presents and is re-issued whenever
 * the desired SANs change (e.g. a domain is configured) — without breaking agents,
 * since they trust the CA, not the leaf.
 */
export async function ensureTls(dir: string, inputs: SanInputs = {}): Promise<TlsBundle> {
    await fs.mkdir(dir, { recursive: true });
    const ca = await ensureCa(dir);
    const leaf = await ensureLeaf(dir, ca, inputs);
    return {
        certPath: leaf.certPath,
        keyPath: leaf.keyPath,
        certPem: leaf.certPem,
        keyPem: leaf.keyPem,
        caCertPath: ca.caCertPath,
        caCertPem: ca.caCertPem,
        pin: computePin(leaf.certPem),
    };
}
