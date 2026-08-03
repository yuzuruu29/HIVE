import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CredentialResolver,
  DesktopCredentialMetadata,
  DesktopCredentialReference,
  DesktopCredentialTestResult,
  DesktopCredentialWriteInput,
  ResolvedDesktopCredential,
} from "./types.js";

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const KINDS = new Set(["api-key", "bearer", "oauth"]);

export interface DesktopCredentialEnvelope {
  providerId: string;
  kind: DesktopCredentialWriteInput["kind"];
  ciphertext: string;
  updatedAt: string;
  displayHint?: string;
}

export interface DesktopCredentialEnvelopeStore {
  list(): Promise<DesktopCredentialEnvelope[]>;
  load(providerId: string): Promise<DesktopCredentialEnvelope | null>;
  save(envelope: DesktopCredentialEnvelope): Promise<void>;
  create(envelope: DesktopCredentialEnvelope): Promise<boolean>;
  replace(envelope: DesktopCredentialEnvelope): Promise<boolean>;
  remove(providerId: string): Promise<void>;
  removeIfMatches(providerId: string, kind: DesktopCredentialEnvelope["kind"]): Promise<"removed" | "missing" | "kind-mismatch">;
}

export interface DesktopCredentialCipher {
  isEncryptionAvailable(): boolean;
  encrypt(value: string): Uint8Array;
  decrypt(value: Uint8Array): string;
}

export interface DesktopCredentialVaultOptions {
  store: DesktopCredentialEnvelopeStore;
  cipher: DesktopCredentialCipher;
  clock?: () => string;
  tester?: (credential: ResolvedDesktopCredential) => Promise<boolean | DesktopCredentialTestResult>;
}

export interface DesktopCredentialVaultService {
  list(): Promise<DesktopCredentialMetadata[]>;
  metadata(providerId: string): Promise<DesktopCredentialMetadata | null>;
  set(input: DesktopCredentialWriteInput): Promise<DesktopCredentialMetadata>;
  replace(input: DesktopCredentialWriteInput): Promise<DesktopCredentialMetadata>;
  remove(input: DesktopCredentialReference): Promise<void>;
  test(input: DesktopCredentialReference): Promise<DesktopCredentialTestResult>;
}

function validateProviderId(providerId: string): void {
  if (!PROVIDER_ID.test(providerId)) throw new Error("Invalid credential provider id.");
}

function validateWrite(input: DesktopCredentialWriteInput): void {
  validateProviderId(input.providerId);
  if (!KINDS.has(input.kind)) throw new Error("Invalid credential kind.");
  if (typeof input.secret !== "string" || input.secret.trim().length === 0) {
    throw new Error("A credential value is required.");
  }
  if (input.secret.length > 100_000) throw new Error("Credential value is too large.");
}

function validateEnvelope(value: unknown): DesktopCredentialEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Credential envelope has an invalid shape.");
  const candidate = value as Record<string, unknown>;
  const expected = candidate.displayHint === undefined
    ? ["providerId", "kind", "ciphertext", "updatedAt"]
    : ["providerId", "kind", "ciphertext", "updatedAt", "displayHint"];
  const actual = Object.keys(candidate).sort();
  const wanted = expected.sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("Credential envelope has unknown or missing fields.");
  }
  validateProviderId(String(candidate.providerId ?? ""));
  if (!KINDS.has(String(candidate.kind))) throw new Error("Credential envelope has an invalid kind.");
  if (typeof candidate.ciphertext !== "string" || candidate.ciphertext.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(candidate.ciphertext)) {
    throw new Error("Credential envelope has invalid ciphertext.");
  }
  if (typeof candidate.updatedAt !== "string" || !Number.isFinite(Date.parse(candidate.updatedAt))) {
    throw new Error("Credential envelope has an invalid timestamp.");
  }
  if (candidate.displayHint !== undefined && (typeof candidate.displayHint !== "string" || candidate.displayHint.length > 32)) {
    throw new Error("Credential envelope has an invalid display hint.");
  }
  return {
    providerId: candidate.providerId as string,
    kind: candidate.kind as DesktopCredentialEnvelope["kind"],
    ciphertext: candidate.ciphertext,
    updatedAt: candidate.updatedAt,
    ...(candidate.displayHint === undefined ? {} : { displayHint: candidate.displayHint as string }),
  };
}

function metadata(envelope: DesktopCredentialEnvelope): DesktopCredentialMetadata {
  return {
    providerId: envelope.providerId,
    kind: envelope.kind,
    configured: true,
    updatedAt: envelope.updatedAt,
    ...(envelope.displayHint ? { displayHint: envelope.displayHint } : {}),
  };
}

function hint(secret: string): string {
  if (secret.length <= 8) return "••••";
  const suffix = secret.slice(-4);
  return suffix ? `••••${suffix}` : "••••";
}

class VaultCredentialResolver implements CredentialResolver {
  public constructor(
    private readonly store: DesktopCredentialEnvelopeStore,
    private readonly cipher: DesktopCredentialCipher,
  ) {}

  public async resolve(providerId: string): Promise<ResolvedDesktopCredential | null> {
    validateProviderId(providerId);
    const loaded = await this.store.load(providerId);
    const envelope = loaded ? validateEnvelope(loaded) : null;
    if (!envelope) return null;
    if (!this.cipher.isEncryptionAvailable()) throw new Error("OS-backed credential decryption is unavailable.");
    const secret = this.cipher.decrypt(Buffer.from(envelope.ciphertext, "base64"));
    return { providerId: envelope.providerId, kind: envelope.kind, secret };
  }
}

export class DesktopCredentialVault implements DesktopCredentialVaultService {
  readonly #store: DesktopCredentialEnvelopeStore;
  readonly #cipher: DesktopCredentialCipher;
  readonly #clock: () => string;
  readonly #tester?: DesktopCredentialVaultOptions["tester"];
  public readonly credentialResolver: CredentialResolver;

  public constructor(options: DesktopCredentialVaultOptions) {
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#tester = options.tester;
    this.credentialResolver = new VaultCredentialResolver(options.store, options.cipher);
  }

  public async list(): Promise<DesktopCredentialMetadata[]> {
    const envelopes = (await this.#store.list()).map(validateEnvelope);
    return envelopes.map(metadata).sort((left, right) => left.providerId.localeCompare(right.providerId));
  }

  public async metadata(providerId: string): Promise<DesktopCredentialMetadata | null> {
    validateProviderId(providerId);
    const loaded = await this.#store.load(providerId);
    const envelope = loaded ? validateEnvelope(loaded) : null;
    return envelope ? metadata(envelope) : null;
  }

  public async set(input: DesktopCredentialWriteInput): Promise<DesktopCredentialMetadata> {
    validateWrite(input);
    const envelope = this.#encryptedEnvelope(input);
    if (!(await this.#store.create(envelope))) {
      throw new Error(`Credential metadata already exists for provider ${input.providerId}.`);
    }
    return metadata(envelope);
  }

  public async replace(input: DesktopCredentialWriteInput): Promise<DesktopCredentialMetadata> {
    validateWrite(input);
    const envelope = this.#encryptedEnvelope(input);
    if (!(await this.#store.replace(envelope))) {
      throw new Error(`Credential metadata does not exist for provider ${input.providerId}.`);
    }
    return metadata(envelope);
  }

  public async remove(input: DesktopCredentialReference): Promise<void> {
    validateProviderId(input.providerId);
    const result = await this.#store.removeIfMatches(input.providerId, input.kind);
    if (result === "kind-mismatch") throw new Error("Credential kind does not match stored metadata.");
  }

  public async test(input: DesktopCredentialReference): Promise<DesktopCredentialTestResult> {
    validateProviderId(input.providerId);
    try {
      const resolved = await this.credentialResolver.resolve(input.providerId);
      if (!resolved || resolved.kind !== input.kind) {
        return { providerId: input.providerId, ok: false, message: "Credential is not configured." };
      }
      if (!this.#tester) return { providerId: input.providerId, ok: true, message: "Credential is configured." };
      const result = await this.#tester(resolved);
      if (typeof result !== "boolean") {
        return { providerId: input.providerId, ok: result.ok, message: result.ok ? "Credential is valid." : "Credential test failed." };
      }
      return { providerId: input.providerId, ok: result, message: result ? "Credential is valid." : "Credential test failed." };
    } catch {
      return { providerId: input.providerId, ok: false, message: "Credential test failed." };
    }
  }

  #encryptedEnvelope(input: DesktopCredentialWriteInput): DesktopCredentialEnvelope {
    if (!this.#cipher.isEncryptionAvailable()) {
      throw new Error("OS-backed credential encryption is unavailable; plaintext persistence is refused.");
    }
    const encrypted = this.#cipher.encrypt(input.secret);
    const envelope: DesktopCredentialEnvelope = {
      providerId: input.providerId,
      kind: input.kind,
      ciphertext: Buffer.from(encrypted).toString("base64"),
      updatedAt: this.#clock(),
      displayHint: hint(input.secret),
    };
    return envelope;
  }
}

const credentialFileLocks = new Map<string, Promise<void>>();

async function withCredentialFileLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = credentialFileLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  credentialFileLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (credentialFileLocks.get(key) === current) credentialFileLocks.delete(key);
  }
}

export class JsonCredentialEnvelopeStore implements DesktopCredentialEnvelopeStore {
  readonly #file: string;
  readonly #lockKey: string;

  public constructor(userDataDirectory: string) {
    this.#file = path.resolve(userDataDirectory, "credentials.json");
    this.#lockKey = process.platform === "win32" ? this.#file.toLowerCase() : this.#file;
  }

  public async list(): Promise<DesktopCredentialEnvelope[]> {
    return this.#read();
  }

  async #read(): Promise<DesktopCredentialEnvelope[]> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.#file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Credential envelope store is corrupt.");
      return parsed.map(validateEnvelope);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  public async load(providerId: string): Promise<DesktopCredentialEnvelope | null> {
    validateProviderId(providerId);
    return (await this.list()).find((entry) => entry.providerId === providerId) ?? null;
  }

  public async save(envelope: DesktopCredentialEnvelope): Promise<void> {
    const valid = validateEnvelope(envelope);
    await withCredentialFileLock(this.#lockKey, async () => {
      const entries = (await this.#read()).filter((entry) => entry.providerId !== valid.providerId);
      entries.push(valid);
      await this.#write(entries);
    });
  }

  public async create(envelope: DesktopCredentialEnvelope): Promise<boolean> {
    const valid = validateEnvelope(envelope);
    return withCredentialFileLock(this.#lockKey, async () => {
      const entries = await this.#read();
      if (entries.some((entry) => entry.providerId === valid.providerId)) return false;
      entries.push(valid);
      await this.#write(entries);
      return true;
    });
  }

  public async replace(envelope: DesktopCredentialEnvelope): Promise<boolean> {
    const valid = validateEnvelope(envelope);
    return withCredentialFileLock(this.#lockKey, async () => {
      const entries = await this.#read();
      const index = entries.findIndex((entry) => entry.providerId === valid.providerId);
      if (index < 0) return false;
      entries[index] = valid;
      await this.#write(entries);
      return true;
    });
  }

  public async remove(providerId: string): Promise<void> {
    validateProviderId(providerId);
    await withCredentialFileLock(this.#lockKey, async () => {
      await this.#write((await this.#read()).filter((entry) => entry.providerId !== providerId));
    });
  }

  public async removeIfMatches(
    providerId: string,
    kind: DesktopCredentialEnvelope["kind"],
  ): Promise<"removed" | "missing" | "kind-mismatch"> {
    validateProviderId(providerId);
    if (!KINDS.has(kind)) throw new Error("Invalid credential kind.");
    return withCredentialFileLock(this.#lockKey, async () => {
      const entries = await this.#read();
      const existing = entries.find((entry) => entry.providerId === providerId);
      if (!existing) return "missing";
      if (existing.kind !== kind) return "kind-mismatch";
      await this.#write(entries.filter((entry) => entry.providerId !== providerId));
      return "removed";
    });
  }

  async #write(entries: DesktopCredentialEnvelope[]): Promise<void> {
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await fs.rename(temporary, this.#file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
