import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const API_KEY_PREFIX = "hive_live_";

export interface GeneratedApiKey {
  raw: string;
  prefix: string;
  digest: string;
}

export function generateHiveApiKey(pepper: string): GeneratedApiKey {
  if (pepper.length < 32) throw new Error("HIVE_API_KEY_PEPPER must contain at least 32 characters.");
  const raw = `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    raw,
    prefix: raw.slice(0, API_KEY_PREFIX.length + 10),
    digest: digestHiveApiKey(raw, pepper),
  };
}

export function digestHiveApiKey(raw: string, pepper: string): string {
  return createHmac("sha256", pepper).update(raw, "utf8").digest("hex");
}

export function verifyHiveApiKey(raw: string, expectedDigest: string, pepper: string): boolean {
  if (!raw.startsWith(API_KEY_PREFIX) || !/^[a-f0-9]{64}$/i.test(expectedDigest)) return false;
  const actual = Buffer.from(digestHiveApiKey(raw, pepper), "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface EncryptedSecretEnvelope {
  version: 1;
  wrappedKey: string;
  wrappedKeyIv: string;
  wrappedKeyTag: string;
  ciphertext: string;
  iv: string;
  tag: string;
}

function decodeKek(kekBase64: string): Buffer {
  const kek = Buffer.from(kekBase64, "base64");
  if (kek.length !== 32) throw new Error("HIVE_ENCRYPTION_KEK_BASE64 must decode to exactly 32 bytes.");
  return kek;
}

function encryptAesGcm(plaintext: Buffer, key: Buffer, aad: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decryptAesGcm(ciphertext: Buffer, key: Buffer, iv: Buffer, tag: Buffer, aad: Buffer) {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptProviderSecret(secret: string, kekBase64: string, tenantId: string, providerId: string): EncryptedSecretEnvelope {
  const kek = decodeKek(kekBase64);
  const dataKey = randomBytes(32);
  const aad = Buffer.from(`hive-provider:${tenantId}:${providerId}`, "utf8");
  const wrapped = encryptAesGcm(dataKey, kek, aad);
  const payload = encryptAesGcm(Buffer.from(secret, "utf8"), dataKey, aad);
  dataKey.fill(0);
  return {
    version: 1,
    wrappedKey: wrapped.ciphertext.toString("base64"),
    wrappedKeyIv: wrapped.iv.toString("base64"),
    wrappedKeyTag: wrapped.tag.toString("base64"),
    ciphertext: payload.ciphertext.toString("base64"),
    iv: payload.iv.toString("base64"),
    tag: payload.tag.toString("base64"),
  };
}

export function decryptProviderSecret(envelope: EncryptedSecretEnvelope, kekBase64: string, tenantId: string, providerId: string): string {
  if (envelope.version !== 1) throw new Error("Unsupported provider-secret envelope version.");
  const kek = decodeKek(kekBase64);
  const aad = Buffer.from(`hive-provider:${tenantId}:${providerId}`, "utf8");
  const dataKey = decryptAesGcm(
    Buffer.from(envelope.wrappedKey, "base64"),
    kek,
    Buffer.from(envelope.wrappedKeyIv, "base64"),
    Buffer.from(envelope.wrappedKeyTag, "base64"),
    aad,
  );
  try {
    return decryptAesGcm(
      Buffer.from(envelope.ciphertext, "base64"),
      dataKey,
      Buffer.from(envelope.iv, "base64"),
      Buffer.from(envelope.tag, "base64"),
      aad,
    ).toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}

export interface InternalSubject {
  userId: string;
  tenantId: string;
  role: "owner" | "member";
  email: string;
}

export function createInternalAuthHeaders(subject: InternalSubject, secret: string, method: string, path: string, now = Date.now()) {
  if (secret.length < 32) throw new Error("INTERNAL_SERVICE_SECRET must contain at least 32 characters.");
  const encodedSubject = Buffer.from(JSON.stringify(subject), "utf8").toString("base64url");
  const timestamp = String(now);
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}\n${method.toUpperCase()}\n${path}\n${encodedSubject}`, "utf8")
    .digest("hex");
  return {
    "x-hive-internal-subject": encodedSubject,
    "x-hive-internal-timestamp": timestamp,
    "x-hive-internal-signature": signature,
  };
}

export function verifyInternalAuthHeaders(
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  method: string,
  path: string,
  now = Date.now(),
): InternalSubject | null {
  const subjectHeader = headerValue(headers["x-hive-internal-subject"]);
  const timestampHeader = headerValue(headers["x-hive-internal-timestamp"]);
  const signatureHeader = headerValue(headers["x-hive-internal-signature"]);
  if (!subjectHeader || !timestampHeader || !signatureHeader || !/^\d+$/.test(timestampHeader)) return null;
  if (Math.abs(now - Number(timestampHeader)) > 30_000) return null;
  const expected = createHmac("sha256", secret)
    .update(`${timestampHeader}\n${method.toUpperCase()}\n${path}\n${subjectHeader}`, "utf8")
    .digest("hex");
  if (!safeEqualHex(signatureHeader, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(subjectHeader, "base64url").toString("utf8")) as InternalSubject;
    if (!parsed.userId || !parsed.tenantId || !parsed.email || !["owner", "member"].includes(parsed.role)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function ipv4ToNumber(ip: string): number {
  return ip.split(".").reduce((total, part) => ((total << 8) | Number(part)) >>> 0, 0);
}

function inCidr(ip: string, network: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToNumber(ip) & mask) === (ipv4ToNumber(network) & mask);
}

export function isBlockedAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isBlockedAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    return [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
      ["224.0.0.0", 4], ["240.0.0.0", 4],
    ].some(([network, bits]) => inCidr(normalized, network as string, bits as number));
  }
  if (isIP(normalized) === 6) {
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) || normalized.startsWith("ff") || normalized.startsWith("2001:db8") ||
      normalized.startsWith("2001:2:");
  }
  return true;
}

export type PublicEndpointLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<readonly { address: string; family: number }[]>;

export interface ResolvedPublicHttpsEndpoint {
  url: URL;
  addresses: readonly { address: string; family: 4 | 6 }[];
}

export async function resolvePublicHttpsEndpoint(
  value: string,
  lookup: PublicEndpointLookup = dnsLookup as PublicEndpointLookup,
): Promise<ResolvedPublicHttpsEndpoint> {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Custom provider URLs must use HTTPS.");
  if (url.username || url.password) throw new Error("Credentials are not allowed in provider URLs.");
  if (!url.hostname || url.hostname.length > 253) throw new Error("Provider hostname is invalid.");
  if (isIP(url.hostname) && isBlockedAddress(url.hostname)) throw new Error("Private or reserved provider addresses are not allowed.");
  const results = await lookup(url.hostname, { all: true, verbatim: true });
  if (results.length === 0 || results.some((result) => ![4, 6].includes(result.family) || isBlockedAddress(result.address))) {
    throw new Error("Provider hostname resolves to a private or reserved address.");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return {
    url,
    addresses: results.map((result) => ({ address: result.address, family: result.family as 4 | 6 })),
  };
}

export function createPinnedLookup(expectedHostname: string, addresses: ResolvedPublicHttpsEndpoint["addresses"]): LookupFunction {
  let index = 0;
  return (hostname, options, callback) => {
    if (hostname.toLowerCase().replace(/\.$/, "") !== expectedHostname.toLowerCase().replace(/\.$/, "")) {
      const error = Object.assign(new Error("Outbound hostname changed after validation."), { code: "EACCES" });
      callback(error, "", 0);
      return;
    }
    const requestedFamily = typeof options.family === "number" && options.family !== 0 ? options.family : undefined;
    const eligible = requestedFamily ? addresses.filter((entry) => entry.family === requestedFamily) : addresses;
    const selected = eligible[index % eligible.length];
    if (!selected) {
      const error = Object.assign(new Error("No validated address matches the requested network family."), { code: "EADDRNOTAVAIL" });
      callback(error, "", 0);
      return;
    }
    index += 1;
    if (options.all) callback(null, eligible.map((entry) => ({ address: entry.address, family: entry.family })));
    else callback(null, selected.address, selected.family);
  };
}

export interface PublicHttpsFetchOptions {
  lookup?: PublicEndpointLookup;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export async function fetchPublicHttpsEndpoint(
  value: string,
  init: NonNullable<Parameters<typeof undiciFetch>[1]> = {},
  options: PublicHttpsFetchOptions = {},
): Promise<Response> {
  const resolved = await resolvePublicHttpsEndpoint(value, options.lookup);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxResponseBytes = options.maxResponseBytes ?? 10 * 1024 * 1024;
  const dispatcher = new Agent({
    connections: 1,
    pipelining: 0,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connect: {
      lookup: createPinnedLookup(resolved.url.hostname, resolved.addresses),
      timeout: timeoutMs,
    },
  });
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    response = await undiciFetch(resolved.url, { ...init, dispatcher, redirect: "error", signal });
  } catch (error) {
    await dispatcher.destroy();
    throw error;
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    await response.body?.cancel();
    await dispatcher.destroy();
    throw new Error("Provider response exceeds the configured size limit.");
  }
  if (!response.body) {
    await dispatcher.close();
    return response as unknown as Response;
  }

  const reader = response.body.getReader();
  let received = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          await dispatcher.close();
          return;
        }
        received += chunk.value.byteLength;
        if (received > maxResponseBytes) {
          await reader.cancel();
          await dispatcher.destroy();
          controller.error(new Error("Provider response exceeds the configured size limit."));
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        await dispatcher.destroy();
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      await dispatcher.destroy();
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function validatePublicHttpsEndpoint(
  value: string,
  lookup: PublicEndpointLookup = dnsLookup as PublicEndpointLookup,
): Promise<URL> {
  return (await resolvePublicHttpsEndpoint(value, lookup)).url;
}
