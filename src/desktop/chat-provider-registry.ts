import { createChatEngine, type ChatEngine } from "../chat/engine.js";
import { ProviderRouter, type ProviderRegistryLike } from "../coding/provider-router.js";
import { getAdapterForKind } from "../providers/health.js";
import type { ProviderAdapter, ProviderCompletionResult, ProviderConfig, ProviderHealthResult, ProviderRequestCredential } from "../providers/types.js";
import { redactKnownSecrets } from "../security/secrets.js";
import type { DesktopCredentialVaultService } from "./credential-vault.js";
import type { JsonDesktopAppStateStore } from "./electron/app-state.js";

export interface DesktopChatProviderOptions {
  stateStore: Pick<JsonDesktopAppStateStore, "load">;
  credentialVault: Pick<DesktopCredentialVaultService, "credentialResolver">;
  adapterFactory?: (kind: ProviderConfig["kind"]) => ProviderAdapter;
}

interface ProviderRequest {
  config: ProviderConfig;
  credential?: ProviderRequestCredential;
  literals: string[];
}

function credentialLiterals(secret: string): string[] {
  const bytes = Buffer.from(secret);
  const base64 = bytes.toString("base64");
  const hex = bytes.toString("hex");
  const literals = new Set([secret, JSON.stringify(secret).slice(1, -1), base64, base64.replace(/=+$/u, ""), bytes.toString("base64url"), hex, hex.toUpperCase()]);
  try {
    for (const encoded of [encodeURI(secret), encodeURIComponent(secret)]) {
      literals.add(encoded);
      literals.add(encoded.replace(/%[A-F0-9]{2}/gu, (escape) => escape.toLowerCase()));
    }
  } catch { /* Raw and JSON forms still protect malformed Unicode credentials. */ }
  return [...literals].filter(Boolean).sort((left, right) => right.length - left.length);
}

function redactParts(value: string, literals: readonly string[], streaming = false): { output: string; pending: string } {
  if (literals.length === 0) return { output: value, pending: "" };
  let output = "";
  let index = 0;
  while (index < value.length) {
    // Keep a possible longer match before replacing a shorter overlapping one.
    // No prefix of a split credential may reach the renderer while awaiting its suffix.
    if (streaming && literals.some((literal) => literal.length > value.length - index && literal.startsWith(value.slice(index)))) break;
    const matched = literals.find((literal) => value.startsWith(literal, index));
    if (matched) {
      output += "[REDACTED]";
      index += matched.length;
    } else {
      output += value[index];
      index += 1;
    }
  }
  return { output, pending: value.slice(index) };
}

/** Request-local redaction for provider metadata and failures sent to the renderer. */
export function createDesktopCredentialRedactor(secret?: string): (value: string) => string {
  const literals = secret ? credentialLiterals(secret) : [];
  return (value) => redactKnownSecrets(redactParts(value, literals).output);
}

function publicError(error: unknown, literals: readonly string[], signal?: AbortSignal): Error {
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    const cancelled = new Error("Desktop provider request cancelled.");
    cancelled.name = "AbortError";
    return cancelled;
  }
  return new Error(redactKnownSecrets(redactParts(error instanceof Error ? error.message : String(error), literals).output));
}

function publicCompletion(result: ProviderCompletionResult, literals: readonly string[]): ProviderCompletionResult {
  const usage = result.usage;
  const safeUsage = usage && [usage.promptTokens, usage.completionTokens, usage.totalTokens].every((value) => Number.isSafeInteger(value) && value >= 0)
    ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens }
    : undefined;
  return {
    output: redactParts(result.output, literals).output,
    ...(safeUsage ? { usage: safeUsage } : {}),
  };
}

/** Desktop-only routing with credentials resolved inside each adapter call, never in cached adapters/configs. */
export function createDesktopChatProviderRegistry(options: DesktopChatProviderOptions): ProviderRegistryLike {
  const adapterFactory = options.adapterFactory ?? getAdapterForKind;

  async function configuration(id: string): Promise<ProviderConfig | undefined> {
    let state: Awaited<ReturnType<typeof options.stateStore.load>>;
    try { state = await options.stateStore.load(); }
    catch { throw new Error("Desktop provider metadata is unavailable."); }
    const provider = state.providers.find((entry) => entry.id === id);
    if (!provider) return undefined;
    return {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      authType: provider.authType,
      approved: provider.approved,
      ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
      ...(provider.defaultModel ? { defaultModel: provider.defaultModel } : {}),
      createdAt: state.updatedAt,
      updatedAt: state.updatedAt,
    };
  }

  async function withRequest<T>(id: string, signal: AbortSignal | undefined, operation: (request: ProviderRequest) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const config = await configuration(id);
    signal?.throwIfAborted();
    if (!config) throw new Error(`Desktop provider ${id} is not configured.`);
    if (!config.approved) throw new Error(`Desktop provider ${id} is not approved.`);
    if (config.authType === "none" && ["openai", "openrouter", "anthropic", "google", "chatgpt-subscription"].includes(config.kind)) {
      throw new Error("This desktop provider adapter requires explicit credential authentication.");
    }
    if (config.authType === "oauth" && config.kind !== "oauth") throw new Error("This desktop provider adapter does not support OAuth authentication.");
    if (config.kind === "ollama" && config.authType !== "none") throw new Error("The desktop Ollama adapter requires no-auth configuration.");
    let credential: ProviderRequestCredential | undefined;
    if (config.authType !== "none") {
      try {
        const resolved = await options.credentialVault.credentialResolver?.resolve(id);
        if (!resolved || resolved.providerId !== id || resolved.kind !== config.authType || !resolved.secret) {
          throw new Error("Missing or mismatched desktop credential.");
        }
        credential = { secret: resolved.secret, kind: resolved.kind };
      } catch { throw new Error("Desktop provider credential is unavailable or has a mismatched kind."); }
    }
    const literals = credential ? credentialLiterals(credential.secret) : [];
    try {
      signal?.throwIfAborted();
      const result = await operation({ config, credential, literals });
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      throw publicError(error, literals, signal);
    } finally {
      if (credential) credential.secret = "";
      literals.fill("");
      literals.length = 0;
    }
  }

  async function test(id: string, signal?: AbortSignal): Promise<ProviderHealthResult> {
    return withRequest(id, signal, async ({ config, credential, literals }) => {
      const result = await adapterFactory(config.kind).healthCheck(config, credential, signal);
      return {
        ok: result.ok,
        providerId: config.id,
        message: redactKnownSecrets(redactParts(result.message, literals).output),
        ...(result.model ? { model: redactParts(result.model, literals).output } : {}),
        ...(result.redactedError ? { redactedError: redactKnownSecrets(redactParts(result.redactedError, literals).output) } : {}),
      };
    });
  }

  function requestAdapter(id: string, kind: ProviderConfig["kind"]): ProviderAdapter {
    return {
      kind,
      healthCheck(_config, _credential, signal) { return test(id, signal); },
      complete(_config, input) {
        return withRequest(id, input.signal, async ({ config, credential, literals }) => {
          const result = await adapterFactory(config.kind).complete(config, input, credential);
          return publicCompletion(result, literals);
        });
      },
      streamComplete(_config, input, onChunk) {
        return withRequest(id, input.signal, async ({ config, credential, literals }) => {
          const adapter = adapterFactory(config.kind);
          let pending = "";
          let delivered = "";
          let accepting = true;
          const emit = (chunk: string): void => {
            if (!chunk) return;
            delivered += chunk;
            onChunk(chunk);
          };
          const handleChunk = (chunk: string): void => {
            if (!accepting || input.signal?.aborted) return;
            const next = redactParts(pending + chunk, literals, true);
            pending = next.pending;
            emit(next.output);
          };
          try {
            const result = adapter.streamComplete
              ? await adapter.streamComplete(config, input, handleChunk, credential)
              : await adapter.complete(config, input, credential);
            input.signal?.throwIfAborted();
            const completion = publicCompletion(result, literals);
            if (completion.output.startsWith(delivered)) emit(completion.output.slice(delivered.length));
            return completion;
          } finally {
            // Failed/cancelled streams discard held prefixes, and late callbacks cannot flush them.
            accepting = false;
            pending = "";
          }
        });
      },
    };
  }

  return {
    get: configuration,
    async getRoles() { return {}; },
    test,
    async getAdapter(id) {
      // ProviderRouter caches health. Validate current approval/storage even on cached routes.
      const config = await withRequest(id, undefined, async ({ config }) => config);
      return { config, adapter: requestAdapter(id, config.kind) };
    },
  };
}

export function createDesktopChatEngine(projectRoot: string, sessionId: string, options: DesktopChatProviderOptions): ChatEngine {
  const registry = createDesktopChatProviderRegistry(options);
  const router = new ProviderRouter({ projectRoot, sessionId, projectRegistry: registry, globalRegistry: registry });
  return createChatEngine(projectRoot, sessionId, { router });
}
