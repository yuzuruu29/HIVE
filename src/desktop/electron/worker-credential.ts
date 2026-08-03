import { getAdapterForKind } from "../../providers/health.js";
import type { ProviderAdapter, ProviderConfig, ProviderRoles } from "../../providers/types.js";
import type { ProviderRegistryLike } from "../../coding/provider-router.js";
import type { DesktopCredentialKind, DesktopProviderMetadata } from "../types.js";

export interface DesktopWorkerCredential {
  provider: DesktopProviderMetadata;
  kind?: DesktopCredentialKind;
  secret?: string;
}

function ephemeralConfig(credential: DesktopWorkerCredential): ProviderConfig {
  const timestamp = new Date().toISOString();
  return {
    id: credential.provider.id,
    name: credential.provider.name,
    kind: credential.provider.kind,
    authType: credential.provider.authType,
    approved: credential.provider.approved,
    defaultModel: credential.provider.defaultModel,
    baseUrl: credential.provider.baseUrl,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function secretSafeError(error: unknown, secret?: string): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const message = secret ? raw.replaceAll(secret, "[REDACTED]") : raw;
  const safe = new Error(message);
  safe.name = error instanceof Error ? error.name : "Error";
  return safe;
}

function safeAdapter(adapter: ProviderAdapter, secret?: string, kind?: DesktopCredentialKind): ProviderAdapter {
  const requestCredential = secret && kind ? { secret, kind } : undefined;
  return {
    kind: adapter.kind,
    async healthCheck(config) {
      try {
        const result = await adapter.healthCheck(config, requestCredential);
        return secret ? { ...result, message: result.message.replaceAll(secret, "[REDACTED]"), ...(result.redactedError ? { redactedError: result.redactedError.replaceAll(secret, "[REDACTED]") } : {}) } : result;
      } catch (error) { throw secretSafeError(error, secret); }
    },
    async complete(config, input) {
      try {
        const result = await adapter.complete(config, input, requestCredential);
        return secret ? { ...result, output: result.output.replaceAll(secret, "[REDACTED]") } : result;
      }
      catch (error) { throw secretSafeError(error, secret); }
    },
  };
}

function registryFor(config: ProviderConfig, secret: string | undefined, credentialKind: DesktopCredentialKind | undefined, adapterFactory: (kind: ProviderConfig["kind"]) => ProviderAdapter): ProviderRegistryLike {
  return {
    async get(id) { return id === config.id ? { ...config } : undefined; },
    async getRoles(): Promise<ProviderRoles> { return {}; },
    async test(id) {
      if (id !== config.id) throw new Error(`Provider ${id} not found.`);
      return safeAdapter(adapterFactory(config.kind), secret, credentialKind).healthCheck(config);
    },
    async getAdapter(id) {
      if (id !== config.id) throw new Error(`Provider ${id} not found.`);
      return { adapter: safeAdapter(adapterFactory(config.kind), secret, credentialKind), config: { ...config } };
    },
  };
}

export async function withDesktopCredentialRuntime<T>(
  credential: DesktopWorkerCredential | undefined,
  operation: (registry: ProviderRegistryLike | undefined) => Promise<T>,
  options: { adapterFactory?: (kind: ProviderConfig["kind"]) => ProviderAdapter } = {},
): Promise<T> {
  if (!credential) return operation(undefined);
  const requiresSecret = credential.provider.authType !== "none";
  if (requiresSecret && (!credential.secret || !credential.kind)) throw new Error("Desktop provider credential is unavailable.");
  const secret = credential.secret;
  const registry = registryFor(ephemeralConfig(credential), secret, credential.kind, options.adapterFactory ?? getAdapterForKind);
  try { return await operation(registry); }
  catch (error) { throw secretSafeError(error, secret); }
  finally {
    if (credential.secret) credential.secret = undefined;
  }
}
