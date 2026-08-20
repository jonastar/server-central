import * as fs from "node:fs/promises";
import * as path from "node:path";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import type { OidcAuthorizeParams, OidcClient } from "@central/shared";
import { CONFIG_DIR, writeFileAtomic } from "../../config";

interface OidcClientRecord {
    id: string;
    name: string;
    redirectUris: string[];
    secretHash: string;
    createdAt: number;
}

function toPublic(rec: OidcClientRecord): OidcClient {
    return { id: rec.id, name: rec.name, redirectUris: rec.redirectUris, createdAt: rec.createdAt };
}

export interface SigningKey {
    kid: string;
    privateKeyPem: string;
    publicKeyPem: string;
    createdAt: number;
}

/** A pending authorization: single-use and short-lived, so it's kept in memory
 *  rather than a persisted store — a restart mid-login just fails that attempt. */
interface AuthCodeRecord {
    userId: string;
    clientId: string;
    redirectUri: string;
    scope: string;
    codeChallenge: string;
    nonce: string | null;
    issuedAt: number;
    expiresAt: number;
}

const CODE_TTL_MS = 60 * 1000;

/**
 * File-backed app registrations (`.sc-data/apps.json`, same atomic-write shape
 * as `AuthStore`) and the provider's RSA signing keypair
 * (`.sc-data/oidc-signing-key.json`, generated once on first use and reused
 * forever after — see tls.ts's ensureCa for the same "generate once, persist"
 * pattern applied to the TLS CA). Client secrets are hashed with Bun.password
 * exactly like user passwords: shown once at creation, never retrievable again.
 */
export class OidcStore {
    private apps: Record<string, OidcClientRecord> = {};
    private signingKey: SigningKey | null = null;
    private codes = new Map<string, AuthCodeRecord>();
    private readonly appsFile: string;
    private readonly keyFile: string;

    constructor(dataDir: string = CONFIG_DIR) {
        this.appsFile = path.join(dataDir, "apps.json");
        this.keyFile = path.join(dataDir, "oidc-signing-key.json");
    }

    async init(): Promise<void> {
        this.apps = await readJson<Record<string, OidcClientRecord>>(this.appsFile, {});
        this.signingKey = await readJson<SigningKey | null>(this.keyFile, null) ?? await this.createSigningKey();
    }

    /** The active signing key. Only valid after init(). */
    get key(): SigningKey {
        if (!this.signingKey) {
            throw new Error("OidcStore not initialized");
        }
        return this.signingKey;
    }

    private async createSigningKey(): Promise<SigningKey> {
        const { publicKey, privateKey } = generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
        });
        const key: SigningKey = { kid: randomUUID(), privateKeyPem: privateKey, publicKeyPem: publicKey, createdAt: Date.now() };
        await writeJson(this.keyFile, key);
        console.log("Generated OIDC signing key at", this.keyFile);
        return key;
    }

    listClients(): OidcClient[] {
        return Object.values(this.apps).map(toPublic);
    }

    async createClient(name: string, redirectUris: string[]): Promise<{ client: OidcClient; clientSecret: string }> {
        const trimmedName = name.trim();
        if (!trimmedName) {
            throw new Error("Client name is required");
        }
        const uris = redirectUris.map((u) => u.trim()).filter(Boolean);
        if (uris.length === 0) {
            throw new Error("At least one redirect URI is required");
        }
        for (const uri of uris) {
            try {
                new URL(uri);
            } catch {
                throw new Error(`Invalid redirect URI: ${uri}`);
            }
        }
        const clientSecret = randomBytes(32).toString("base64url");
        const rec: OidcClientRecord = {
            id: randomUUID(),
            name: trimmedName,
            redirectUris: uris,
            secretHash: await Bun.password.hash(clientSecret),
            createdAt: Date.now(),
        };
        this.apps[rec.id] = rec;
        await this.persistApps();
        return { client: toPublic(rec), clientSecret };
    }

    async deleteClient(clientId: string): Promise<void> {
        if (this.apps[clientId]) {
            delete this.apps[clientId];
            await this.persistApps();
        }
    }

    /** Validate an authorization request against the registered client, without
     *  minting anything — used both for the confirm-screen lookup and as the
     *  first step of actually issuing a code. */
    validateRequest(params: OidcAuthorizeParams): OidcClient {
        const rec = this.apps[params.clientId];
        if (!rec) {
            throw new Error("Unknown client");
        }
        if (!rec.redirectUris.includes(params.redirectUri)) {
            throw new Error("redirect_uri does not match a registered URI for this client");
        }
        if (params.codeChallengeMethod !== "S256" || !params.codeChallenge) {
            throw new Error("PKCE (S256 code_challenge) is required");
        }
        return toPublic(rec);
    }

    /** Authenticate the client at the token endpoint (client_secret_post/basic). */
    async verifyClientSecret(clientId: string, secret: string): Promise<OidcClient | null> {
        const rec = this.apps[clientId];
        if (!rec) {
            return null;
        }
        return (await Bun.password.verify(secret, rec.secretHash)) ? toPublic(rec) : null;
    }

    /** Mint a single-use authorization code bound to this exact request. */
    issueCode(params: Omit<AuthCodeRecord, "issuedAt" | "expiresAt">): string {
        const code = randomBytes(32).toString("base64url");
        const now = Date.now();
        this.codes.set(code, { ...params, issuedAt: now, expiresAt: now + CODE_TTL_MS });
        return code;
    }

    /** Consume a code — returns it once, then it's gone (single-use), or null if
     *  unknown/expired. */
    consumeCode(code: string): AuthCodeRecord | null {
        const rec = this.codes.get(code);
        this.codes.delete(code);
        if (!rec || rec.expiresAt < Date.now()) {
            return null;
        }
        return rec;
    }

    private async persistApps(): Promise<void> {
        await writeJson(this.appsFile, this.apps);
    }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
    try {
        return JSON.parse(await fs.readFile(file, "utf8")) as T;
    } catch {
        return fallback;
    }
}

async function writeJson(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, JSON.stringify(value, null, 2));
}
