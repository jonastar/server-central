import * as fs from "node:fs/promises";
import * as path from "node:path";
import { X509Certificate, createHash } from "node:crypto";
import { CONTROL_PLANE_TLS_SERVERNAME } from "@central/shared";

export interface TlsBundle {
    certPath: string;
    keyPath: string;
    certPem: string;
    keyPem: string;
    /** Format curl --pinnedpubkey expects: "sha256//<base64>" */
    pin: string;
}

// SAN the cert is issued for. Agents pin the exact cert and connect with a
// fixed `servername` of CONTROL_PLANE_TLS_SERVERNAME, so verification is
// host-independent (works by IP or domain). localhost/127.0.0.1 are included
// for convenience (e.g. browsers, local tooling).
const SAN = `subjectAltName=DNS:${CONTROL_PLANE_TLS_SERVERNAME},DNS:localhost,IP:127.0.0.1`;

function computePin(certPem: string): string {
    const spkiDer = new X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" });
    return "sha256//" + createHash("sha256").update(spkiDer).digest("base64");
}

/** True if the cert already carries the control-plane SAN the agent verifies against. */
function hasRequiredSan(certPem: string): boolean {
    try {
        return new X509Certificate(certPem).subjectAltName?.includes(`DNS:${CONTROL_PLANE_TLS_SERVERNAME}`) ?? false;
    } catch {
        return false;
    }
}

export async function ensureTls(dir: string): Promise<TlsBundle> {
    await fs.mkdir(dir, { recursive: true });

    const certPath = path.join(dir, "server.crt");
    const keyPath = path.join(dir, "server.key");

    const exists = await Promise.all([
        fs.access(certPath).then(() => true).catch(() => false),
        fs.access(keyPath).then(() => true).catch(() => false),
    ]);

    // Regenerate a legacy cert that predates the SAN: agents can no longer
    // verify it when connecting by hostname (Bun enforces hostname↔SAN).
    const staleSan = exists[0] && !hasRequiredSan(await fs.readFile(certPath, "utf8").catch(() => ""));
    if (staleSan) console.log("Existing TLS cert lacks the control-plane SAN; regenerating");

    if (!exists[0] || !exists[1] || staleSan) {
        const proc = Bun.spawn([
            "openssl", "req", "-x509",
            "-newkey", "ec",
            "-pkeyopt", "ec_paramgen_curve:prime256v1",
            "-keyout", keyPath,
            "-out", certPath,
            "-days", "825",
            "-nodes",
            "-subj", `/CN=${CONTROL_PLANE_TLS_SERVERNAME}`,
            "-addext", SAN,
        ], { stdout: "pipe", stderr: "pipe" });

        const code = await proc.exited;
        if (code !== 0) {
            const errText = await new Response(proc.stderr).text();
            throw new Error(`openssl cert generation failed (code ${code}): ${errText}`);
        }
        console.log("Generated self-signed TLS certificate at", certPath);
    }

    const [certPem, keyPem] = await Promise.all([
        fs.readFile(certPath, "utf8"),
        fs.readFile(keyPath, "utf8"),
    ]);

    return { certPath, keyPath, certPem, keyPem, pin: computePin(certPem) };
}
