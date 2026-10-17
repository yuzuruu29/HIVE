import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cancelled, missing, object } from "./io.js";
import type { ExtensionOptions, McpServerDescriptor, OAuthCipher } from "./types.js";

const MAX_BYTES = 128 * 1024;
// PowerShell 5.1 prepends Program Files\WindowsPowerShell\Modules to any PSModulePath, so
// autoloading Add-Type/ConvertFrom-Json would scan every installed module (10s+ on hosts with
// large module sets) and could resolve a same-named third-party module. Import the built-in
// Utility module by its $PSHOME path instead.
const dpapiScript = `$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility'); Add-Type -AssemblyName System.Security; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $inputRecord=[Console]::ReadLine()|ConvertFrom-Json; $bytes=[Convert]::FromBase64String($inputRecord.data); $entropy=[Text.Encoding]::UTF8.GetBytes('HIVE MCP OAuth v1'); if($inputRecord.operation -eq 'encrypt'){$result=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}else{$result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}; [Console]::Write([Convert]::ToBase64String($result))`;

/** Current-user DPAPI. The credential travels over stdin, never argv or a file. */
export class WindowsOAuthCipher implements OAuthCipher {
  readonly kind = "windows-dpapi-current-user-v1";
  private run(operation: "encrypt" | "decrypt", bytes: Uint8Array): Promise<Uint8Array> {
    if (process.platform !== "win32") return Promise.reject(new Error("OS-backed OAuth encryption is unavailable on this host; provide an OS credential-store integration. Plaintext token storage is refused"));
    if (bytes.byteLength > MAX_BYTES) return Promise.reject(new Error("OAuth encrypted record exceeds its size limit"));
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot || !path.isAbsolute(systemRoot)) return Promise.reject(new Error("Windows system directory is unavailable for DPAPI"));
    return new Promise((resolve, reject) => {
      const powershellHome = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0");
      // Keep the machine/user module paths (e.g. C:\Modules) out of this credential process.
      const child = spawn(path.join(powershellHome, "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", dpapiScript], { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"], env: { SystemRoot: systemRoot, PSModulePath: path.join(powershellHome, "Modules") } });
      let output = ""; let settled = false;
      const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(output) || output.length > MAX_BYTES * 2) reject(new Error("Invalid DPAPI response")); else resolve(Buffer.from(output, "base64")); };
      const timer = setTimeout(() => { child.kill(); finish(new Error("OS-backed OAuth encryption timed out")); }, 10_000);
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("ascii"); if (output.length > MAX_BYTES * 2) { child.kill(); finish(new Error("OS-backed OAuth encryption response exceeded limit")); } });
      child.stderr.resume();
      child.on("error", () => finish(new Error("OS-backed OAuth encryption could not start")));
      child.stdin.on("error", () => finish(new Error("OS-backed OAuth encryption input failed")));
      child.on("close", (code) => finish(code === 0 ? undefined : new Error("OS-backed OAuth encryption failed")));
      child.stdin.end(`${JSON.stringify({ operation, data: Buffer.from(bytes).toString("base64") })}\n`);
    });
  }
  encrypt(plaintext: Uint8Array): Promise<Uint8Array> { return this.run("encrypt", plaintext); }
  decrypt(ciphertext: Uint8Array): Promise<Uint8Array> { return this.run("decrypt", ciphertext); }
}

export interface OAuthRecord {
  version: 1;
  binding: string;
  generation: string;
  issuer: string;
  resource: string;
  clientId: string;
  clientSecret?: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  tokenEndpointAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes: string[];
}

function stamp(stat: Awaited<ReturnType<typeof fs.lstat>>): string { return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink].join(":"); }

async function plainDirectory(directory: string, create: boolean, privateLeaf = false): Promise<void> {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(directory, await fs.realpath(directory)) !== "") throw new Error("OAuth storage requires plain directories without symlinks");
    if (process.platform !== "win32" && privateLeaf && (stat.mode & 0o077) !== 0) throw new Error("OAuth storage directory permissions must be private (0700)");
  } catch (error) {
    if (!create || !missing(error)) throw error;
    const parent = path.dirname(directory); if (parent === directory) throw error;
    await plainDirectory(parent, true);
    await fs.mkdir(directory, { mode: 0o700 }).catch((failure: unknown) => { if (!(failure instanceof Error && "code" in failure && failure.code === "EEXIST")) throw failure; });
    await plainDirectory(directory, false, privateLeaf);
  }
}

export class OAuthStore {
  readonly cipher: OAuthCipher;
  readonly binding: string;
  private readonly directory: string;
  private readonly file: string;
  private readonly generationFile: string;
  constructor(root: string, server: McpServerDescriptor, options: ExtensionOptions = {}) {
    if (server.transport !== "http") throw new Error("OAuth is only supported for HTTP MCP servers");
    this.binding = createHash("sha256").update(JSON.stringify([root, server.id, server.url, server.fingerprint])).digest("hex");
    this.directory = path.resolve(options.authStateDir ?? path.join(os.homedir(), ".hive", "mcp-oauth"));
    const key = createHash("sha256").update(JSON.stringify([root, server.id, server.url])).digest("hex");
    this.file = path.join(this.directory, `${key}.json`);
    this.generationFile = path.join(this.directory, `${key}.generation`);
    this.cipher = options.authCipher ?? new WindowsOAuthCipher();
  }
  async available(): Promise<void> {
    const probe = Buffer.from("HIVE OAuth secure storage probe");
    const restored = await this.cipher.decrypt(await this.cipher.encrypt(probe));
    if (!Buffer.from(restored).equals(probe)) throw new Error("OAuth credential encryption could not be verified");
  }
  /** Logout changes this non-secret tombstone, invalidating grants in other processes. */
  async generation(): Promise<string> {
    let before: Awaited<ReturnType<typeof fs.lstat>>;
    try { await plainDirectory(this.directory, false, true); before = await fs.lstat(this.generationFile); }
    catch (error) { if (missing(error)) return "initial"; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 64) throw new Error("OAuth logout generation storage is unsafe");
    const handle = await fs.open(this.generationFile, "r");
    try {
      if (stamp(before) !== stamp(await handle.stat())) throw new Error("OAuth generation changed while opening");
      const bytes = Buffer.alloc(65); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 64 || stamp(before) !== stamp(await handle.stat()) || stamp(before) !== stamp(await fs.lstat(this.generationFile))) throw new Error("OAuth generation changed while reading");
      const value = bytes.subarray(0, bytesRead).toString("ascii"); if (!/^[a-f0-9-]{36}$/u.test(value)) throw new Error("OAuth generation is invalid"); return value;
    } finally { await handle.close(); }
  }
  /** Caller holds the per-server storage lock. Keep this even when no grant exists. */
  async invalidate(): Promise<void> {
    await this.generation();
    const temporary = `${this.generationFile}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, randomUUID(), { flag: "wx", mode: 0o600 });
    try { await fs.rename(temporary, this.generationFile); } finally { await fs.rm(temporary, { force: true }); }
  }
  async read(): Promise<OAuthRecord | undefined> {
    let before: Awaited<ReturnType<typeof fs.lstat>>;
    try { await plainDirectory(this.directory, false, true); before = await fs.lstat(this.file); }
    catch (error) { if (missing(error)) return undefined; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES || (process.platform !== "win32" && (before.mode & 0o077) !== 0)) throw new Error("OAuth credential storage is unsafe or exceeds its size limit");
    const handle = await fs.open(this.file, "r");
    try {
      if (stamp(before) !== stamp(await handle.stat())) throw new Error("OAuth credentials changed while opening");
      const bytes = Buffer.alloc(MAX_BYTES + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_BYTES || stamp(before) !== stamp(await handle.stat()) || stamp(before) !== stamp(await fs.lstat(this.file))) throw new Error("OAuth credentials changed while reading");
      const envelope = object(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")), "OAuth envelope");
      if (envelope.version !== 1 || envelope.cipher !== this.cipher.kind || typeof envelope.ciphertext !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(envelope.ciphertext)) throw new Error("OAuth credentials use an unavailable cipher or invalid envelope");
      const decrypted = await this.cipher.decrypt(Buffer.from(envelope.ciphertext, "base64"));
      if (decrypted.byteLength > MAX_BYTES) throw new Error("OAuth credential record exceeds its size limit");
      const record = object(JSON.parse(Buffer.from(decrypted).toString("utf8")), "OAuth record");
      if (record.version !== 1 || typeof record.binding !== "string" || typeof record.accessToken !== "string" || typeof record.clientId !== "string" || typeof record.issuer !== "string" || typeof record.resource !== "string" || typeof record.tokenEndpoint !== "string" || !["none", "client_secret_post", "client_secret_basic"].includes(String(record.tokenEndpointAuthMethod)) || !Array.isArray(record.scopes) || record.scopes.some((scope) => typeof scope !== "string")) throw new Error("OAuth credentials are invalid");
      if (record.binding !== this.binding) return undefined;
      const generation = typeof record.generation === "string" ? record.generation : "initial";
      if (generation !== await this.generation()) return undefined;
      record.generation = generation;
      return record as unknown as OAuthRecord;
    } catch (error) {
      if (error instanceof Error && /^(OAuth |OS-backed |Windows |Invalid DPAPI)/u.test(error.message)) throw error;
      throw new Error("OAuth credentials could not be decrypted or validated; log out and authorize again");
    } finally { await handle.close(); }
  }
  async write(record: OAuthRecord, signal?: AbortSignal): Promise<void> {
    const assertCurrent = async () => { if (signal?.aborted) throw cancelled(); if (record.generation !== await this.generation()) throw new Error("OAuth login was invalidated by logout; authorize again"); if (signal?.aborted) throw cancelled(); };
    await assertCurrent();
    if (record.binding !== this.binding) throw new Error("OAuth credential resource binding does not match");
    const plaintext = Buffer.from(JSON.stringify(record)); if (plaintext.length > MAX_BYTES / 2) throw new Error("OAuth record exceeds its size limit");
    const ciphertext = await this.cipher.encrypt(plaintext);
    await assertCurrent();
    const envelope = JSON.stringify({ version: 1, cipher: this.cipher.kind, ciphertext: Buffer.from(ciphertext).toString("base64") });
    if (Buffer.byteLength(envelope) > MAX_BYTES) throw new Error("Encrypted OAuth record exceeds its size limit");
    await plainDirectory(this.directory, true, true);
    const temporary = path.join(this.directory, `.${this.binding}.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(envelope); await handle.sync(); } finally { await handle.close(); }
    try {
      const existing = await fs.lstat(this.file).catch((error: unknown) => { if (missing(error)) return undefined; throw error; });
      if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new Error("OAuth credential destination is unsafe");
      await plainDirectory(this.directory, false, true); await assertCurrent(); await fs.rename(temporary, this.file);
      if (signal?.aborted) { await this.remove(); throw cancelled(); }
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async remove(): Promise<void> {
    let current: Awaited<ReturnType<typeof fs.lstat>>;
    try { await plainDirectory(this.directory, false, true); current = await fs.lstat(this.file); } catch (error) { if (missing(error)) return; throw error; }
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1) throw new Error("OAuth credential destination is unsafe");
    await fs.unlink(this.file);
  }
  async locked<T>(operation: () => Promise<T>): Promise<T> {
    await plainDirectory(this.directory, true, true);
    const lockPath = this.file.replace(/\.json$/u, ".lock");
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try { handle = await fs.open(lockPath, "wx", 0o600); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("Another OAuth update is in progress; retry after it completes. Inspect a stale OAuth lock before removing it"); throw error; }
    const identity = stamp(await handle.stat());
    try { return await operation(); }
    finally { await handle.close(); const current = await fs.lstat(lockPath).catch((error: unknown) => { if (missing(error)) return undefined; throw error; }); if (current && stamp(current) === identity && !current.isSymbolicLink()) await fs.unlink(lockPath); }
  }
}
