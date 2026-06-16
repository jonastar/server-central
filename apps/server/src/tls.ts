import * as fs from "node:fs/promises";
import * as path from "node:path";
import { X509Certificate, createHash } from "node:crypto";

export interface TlsBundle {
    certPath: string;
    keyPath: string;
    certPem: string;
    keyPem: string;
    /** Format curl --pinnedpubkey expects: "sha256//<base64>" */
    pin: string;
}

function computePin(certPem: string): string {
    const spkiDer = new X509Certificate(certPem).publicKey.export({ type: "spki", format: "der" });
    return "sha256//" + createHash("sha256").update(spkiDer).digest("base64");
}

export async function ensureTls(dir: string): Promise<TlsBundle> {
    await fs.mkdir(dir, { recursive: true });

    const certPath = path.join(dir, "server.crt");
    const keyPath = path.join(dir, "server.key");

    const exists = await Promise.all([
        fs.access(certPath).then(() => true).catch(() => false),
        fs.access(keyPath).then(() => true).catch(() => false),
    ]);

    if (!exists[0] || !exists[1]) {
        const proc = Bun.spawn([
            "openssl", "req", "-x509",
            "-newkey", "ec",
            "-pkeyopt", "ec_paramgen_curve:prime256v1",
            "-keyout", keyPath,
            "-out", certPath,
            "-days", "825",
            "-nodes",
            "-subj", "/CN=control-plane",
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
