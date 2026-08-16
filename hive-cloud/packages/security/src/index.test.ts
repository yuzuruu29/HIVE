import { describe, expect, it } from "vitest";
import {
  createInternalAuthHeaders,
  createPinnedLookup,
  decryptProviderSecret,
  encryptProviderSecret,
  generateHiveApiKey,
  isBlockedAddress,
  resolvePublicHttpsEndpoint,
  validatePublicHttpsEndpoint,
  verifyHiveApiKey,
  verifyInternalAuthHeaders,
} from "./index.js";

const PEPPER = "p".repeat(32);
const SECRET = "s".repeat(32);
const KEK = Buffer.alloc(32, 7).toString("base64");

describe("API keys", () => {
  it("generates reveal-once compatible keys and verifies their digest", () => {
    const key = generateHiveApiKey(PEPPER);
    expect(key.raw).toMatch(/^hive_live_/);
    expect(verifyHiveApiKey(key.raw, key.digest, PEPPER)).toBe(true);
    expect(verifyHiveApiKey(`${key.raw}x`, key.digest, PEPPER)).toBe(false);
  });
});

describe("provider secret envelopes", () => {
  it("binds ciphertext to tenant and provider AAD", () => {
    const envelope = encryptProviderSecret("upstream-secret", KEK, "tenant-a", "provider-a");
    expect(decryptProviderSecret(envelope, KEK, "tenant-a", "provider-a")).toBe("upstream-secret");
    expect(() => decryptProviderSecret(envelope, KEK, "tenant-b", "provider-a")).toThrow();
  });
});

describe("internal service authentication", () => {
  it("rejects tampering and stale signatures", () => {
    const now = 1_700_000_000_000;
    const subject = { userId: "u1", tenantId: "t1", email: "owner@example.com", role: "owner" as const };
    const headers = createInternalAuthHeaders(subject, SECRET, "POST", "/api/chat", now);
    expect(verifyInternalAuthHeaders(headers, SECRET, "POST", "/api/chat", now)).toEqual(subject);
    expect(verifyInternalAuthHeaders(headers, SECRET, "GET", "/api/chat", now)).toBeNull();
    expect(verifyInternalAuthHeaders(headers, SECRET, "POST", "/api/chat", now + 31_000)).toBeNull();
  });
});

describe("custom provider URL validation", () => {
  it("blocks private networks and accepts public HTTPS DNS", async () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    await expect(validatePublicHttpsEndpoint("http://models.example.com", async () => [{ address: "8.8.8.8", family: 4 }])).rejects.toThrow("HTTPS");
    await expect(validatePublicHttpsEndpoint("https://models.example.com/v1", async () => [{ address: "10.0.0.8", family: 4 }])).rejects.toThrow("private");
    await expect(validatePublicHttpsEndpoint("https://models.example.com/v1/", async () => [{ address: "8.8.8.8", family: 4 }])).resolves.toMatchObject({ pathname: "/v1" });
  });

  it("blocks reserved IPv4, mapped IPv4, multicast IPv6, and mixed DNS answers", async () => {
    for (const address of ["240.0.0.1", "255.255.255.255", "::ffff:127.0.0.1", "ff02::1", "2001:db8::1"]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    await expect(resolvePublicHttpsEndpoint("https://models.example.com/v1", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ])).rejects.toThrow("private");
  });

  it("pins connections to the addresses returned by the validated lookup", async () => {
    const resolved = await resolvePublicHttpsEndpoint("https://models.example.com/v1", async () => [
      { address: "8.8.8.8", family: 4 },
    ]);
    const pinnedLookup = createPinnedLookup(resolved.url.hostname, resolved.addresses);
    const address = await new Promise<string>((resolve, reject) => {
      pinnedLookup("models.example.com", { family: 4 }, (error, result) => {
        if (error) reject(error);
        else resolve(typeof result === "string" ? result : result[0]?.address ?? "");
      });
    });
    expect(address).toBe("8.8.8.8");
    await expect(new Promise((resolve, reject) => {
      pinnedLookup("rebound.example.com", { family: 4 }, (error, result) => error ? reject(error) : resolve(result));
    })).rejects.toThrow("changed after validation");
  });
});
