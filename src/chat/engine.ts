import os from "node:os";
import { ProviderRouter } from "../coding/provider-router.js";
import { ProviderRegistry } from "../providers/registry.js";
import type {
  ChatBindingRole,
  ProviderBindingRole,
  SubagentRole,
} from "../coding/types.js";
import type { ChatReceipt, SessionProviderOverride } from "./types.js";

/**
 * Minimal structural seam over {@link ProviderRouter} so tests (and later
 * harness layers) can inject a stub without touching real registries.
 * The real ProviderRouter satisfies this interface.
 */
export interface ProviderRouterLike {
  resolve(
    role: ProviderBindingRole,
    override?: SessionProviderOverride,
    signal?: AbortSignal,
  ): Promise<ChatRouteSummary>;
  complete(request: {
    role: ProviderBindingRole;
    prompt: string;
    systemPrompt?: string;
    providerId?: string;
    model?: string;
    signal?: AbortSignal;
  }): Promise<{
    output: string;
    usage?: { input?: number; output?: number; total?: number };
  }>;
}

/** Route metadata exposed to chat callers (no adapter/config leakage). */
export interface ChatRouteSummary {
  providerId: string;
  model: string;
  source: string;
  degraded: boolean;
}

export type ChatEngineRole = ChatBindingRole | "queen" | SubagentRole;

export interface ChatCompletionRequest {
  role: ChatEngineRole;
  prompt: string;
  systemPrompt?: string;
  providerId?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  output: string;
  receipt: ChatReceipt;
}

export interface ChatEngineOptions {
  /** Root for the global provider registry; defaults to `os.homedir()`. */
  globalProjectRoot?: string;
  /** Injectable router seam for tests. */
  router?: ProviderRouterLike;
}

export interface ChatEngine {
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
  resolveRoute(
    role: ChatEngineRole,
    override?: SessionProviderOverride,
  ): Promise<ChatRouteSummary>;
}

function overrideFor(request: {
  providerId?: string;
  model?: string;
}): SessionProviderOverride | undefined {
  return request.providerId || request.model
    ? { providerId: request.providerId, model: request.model }
    : undefined;
}

export function createChatEngine(
  projectRoot: string,
  sessionId: string,
  options?: ChatEngineOptions,
): ChatEngine {
  const router: ProviderRouterLike = options?.router ??
    new ProviderRouter({
      projectRoot,
      sessionId,
      globalRegistry: new ProviderRegistry(options?.globalProjectRoot ?? os.homedir()),
    });

  return {
    async complete(request): Promise<ChatCompletionResult> {
      const startedAt = Date.now();
      const route = await router.resolve(
        request.role,
        overrideFor(request),
        request.signal,
      );
      const response = await router.complete({
        role: request.role,
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        providerId: request.providerId,
        model: request.model,
        signal: request.signal,
      });
      const receipt: ChatReceipt = {
        role: request.role,
        providerId: route.providerId,
        model: route.model,
        source: route.source,
        degraded: route.degraded,
        promptTokens: response.usage?.input,
        completionTokens: response.usage?.output,
        totalTokens: response.usage?.total,
        latencyMs: Date.now() - startedAt,
      };
      return { output: response.output, receipt };
    },

    resolveRoute(role, override) {
      return router.resolve(role, override);
    },
  };
}
