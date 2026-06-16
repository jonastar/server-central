The bootstrap flow stays as you designed it: clicking "add node" generates a one-liner that gets copied to the clipboard, the user pastes it into PowerShell or a terminal, and it downloads and runs an installer automatically. The hard part — making that download trustworthy without requiring a CA-signed certificate or any TLS setup on your end — gets solved by embedding a pinned public-key hash in the command itself rather than by hand-rolling encryption. Your control plane runs a self-signed certificate (no CA, no Let's Encrypt, no DNS validation needed), and the generated command includes curl --pinnedpubkey sha256//<hash> against that endpoint. Curl rejects the connection outright if the server presents anything other than the pinned key, so a man-in-the-middle can't substitute a malicious payload even though there's no trusted certificate chain involved. This gets you real TLS — proper authenticated encryption, replay protection, all the parts that are easy to get wrong by hand — for the cost of one flag, rather than you implementing signature verification or AEAD decryption yourself across three different platforms.
The reason this beats a custom encrypt/decrypt scheme isn't just simplicity: writing your own verification logic means picking an AEAD cipher correctly (plain encryption without authentication is vulnerable to tampering even if it looks like "decrypt or throw away" should catch it), and then implementing that consistently across PowerShell's .NET crypto APIs, openssl on Linux, and LibreSSL on macOS — three different toolchains, with openssl not even guaranteed to be present on minimal Linux images. Pinned TLS sidesteps all of that since curl does the verification natively wherever it's installed.
On the distribution side, curl itself is close to universal: native on Linux and macOS, and genuinely shipped as a real, unmodified build on Windows 10/11 since 2018 (not an emulation). --pinnedpubkey works against all three default TLS backends — Schannel on Windows, LibreSSL on macOS, OpenSSL/GnuTLS on Linux — so no extra installs are needed anywhere. The one implementation detail to bake into the generated command: always invoke curl.exe explicitly on Windows rather than bare curl, since default Windows PowerShell (5.1) silently aliases curl to Invoke-WebRequest, a different tool with different flags that would either error or misbehave. PowerShell 7 doesn't have that alias, but you shouldn't rely on which version a given user has.

For distribution we will compiler the project for linux, mac and windows, bun has a --compile option for that.

The communication protocol will be websockets, we will define a seperate protocol to that of the frontend/backend communication, but similar in that it uses typescript types to define the schema.

The control plane might be behind several layers of IP, we need a discovery mechanism using stun.l.google.com:19302 to get the external internet IP, and also use our local IP. The node clients will store both of these and first try the local ip and then the wan ip

As discussed with the bootstrap flow, we will generate a self signed certificate for node communication, this will handle both server-central distribution to nodes as well as the communication over ws itself

Server central can start a https server (does bun have have https built in?) serving both the compiled binaries of itself, and the node API (ws), over the self signed https

exerpt from another claude session on key generation:

Bun runs Node's `crypto` module, so the same APIs you'd reach for in Node work here. There are two separate pieces: generating the actual self-signed certificate (which `node:crypto` alone can't do — it can create raw keypairs but not wrap them in an X.509 certificate), and computing the pinned-key hash to embed in the clipboard command (which `node:crypto` handles fine).

For the certificate itself, since this runs on your control plane — a machine you fully control, unlike the client bootstrap target — there's no reason to avoid `openssl`. It's the standard, well-tested way to produce an X.509 cert, and a one-liner is simpler than pulling in a JS cert-generation library:

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout server.key -out server.crt -days 825 -nodes -subj "/CN=control-plane"
```

That gives you `server.key` and `server.crt`, ready to hand to Bun.

For computing the pin, `node:crypto`'s `X509Certificate` class can pull the public key straight out of that cert, and from there it's a SHA-256 hash of the SPKI-encoded key, base64-ed, in the format curl expects:

```js
import { X509Certificate, createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const certPem = readFileSync("./server.crt", "utf8");
const spkiDer = new X509Certificate(certPem).publicKey.export({
  type: "spki",
  format: "der",
});
const pin = "sha256//" + createHash("sha256").update(spkiDer).digest("base64");
```

I actually ran this against a generated cert and cross-checked it against the canonical `openssl x509 | openssl pkey | openssl dgst` recipe — they produce identical hashes, so this is the correct value to feed `curl --pinnedpubkey`. I tested it in Node rather than Bun directly (Bun wasn't available in my sandbox), but `X509Certificate`, `createHash`, and `generateKeyPairSync` are all part of Bun's Node-compat `node:crypto`, so it should carry over; worth a quick `bun run` to confirm on your machine since compat coverage occasionally has gaps.

Then wiring it into your server with `Bun.serve`:

```js
Bun.serve({
  port: 443,
  tls: {
    cert: Bun.file("./server.crt"),
    key: Bun.file("./server.key"),
  },
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/install") {
      const token = crypto.randomUUID(); // swap for your real one-time-token logic
      return new Response(
        `curl.exe --pinnedpubkey "${pin}" https://your-domain/bootstrap/${token} | bash`,
      );
    }
    if (url.pathname.startsWith("/bootstrap/")) {
      // verify token, then serve the real install script
    }
    return new Response("not found", { status: 404 });
  },
});
```

Compute the pin once at startup rather than per-request, since it's tied to the certificate, not the connection. The one thing to plan for: if you ever rotate the certificate, every previously-copied install command with the old pin baked in becomes invalid (which is somewhat the point), so you'll want short-lived tokens anyway rather than long-lived install links, and curl does let you pass multiple pins separated by `;` if you want a grace period during rotation.
