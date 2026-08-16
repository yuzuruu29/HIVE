import { randomUUID } from "node:crypto";
import {
  HIVE_ROUTER_ID,
  type ChatCompletionRequest,
  type RouteAttempt,
  type RouteCandidate,
  type RouteReceipt,
} from "@hive-cloud/contracts";
import { fetchPublicHttpsEndpoint, validatePublicHttpsEndpoint } from "@hive-cloud/security";
import { providerRequestHeaders } from "./free-providers.js";
import { OpenAIAdapter } from "./openai-adapter.js";
import { AnthropicAdapter } from "./anthropic-adapter.js";
import { PriceRegistry, type PriceSnapshot } from "./price-registry.js";

export {
  BUILTIN_PROVIDER_URLS,
  FreeModelDirectory,
  isFreeProviderModel,
  managedCandidatesFromEnv,
  providerCatalogUrl,
  providerDefinition,
  providerRequestHeaders,
  type FreeModelDescriptor,
  type FreeModelDirectoryOptions,
} from "./free-providers.js";

export { DEFAULT_PRICES } from "./default-prices.js";

export { PriceRegistry, type PriceSnapshot } from "./price-registry.js";
export { CreditSettlement } from "./credit-settlement.js";
export { OpenAIAdapter } from "./openai-adapter.js";
export { AnthropicAdapter } from "./anthropic-adapter.js";

export class RouterError extends Error {
  public readonly code: "no_route" | "upstream_error" | "unsupported_capability";
  public readonly statusCode: number;
  public readonly attempts: RouteAttempt[];
  public readonly requestId: string | undefined;

  public constructor(
    code: RouterError["code"],
    message: string,
    statusCode: number,
    attempts: RouteAttempt[] = [],
    requestId?: string,
  ) {
    super(message);
    this.name = "RouterError";
    this.code = code;
    this.statusCode = statusCode;
    this.attempts = attempts;
    this.requestId = requestId;
  }
}

export interface RouterResult {
  upstream: Response;
  receipt: RouteReceipt;
}

export interface HiveRouterOptions {
  fetch?: typeof fetch;
  customFetch?: typeof fetchPublicHttpsEndpoint;
  validateEndpoint?: typeof validatePublicHttpsEndpoint;
  now?: () => number;
  requestId?: () => string;
}

export interface ManagedRouteOptions {
  priceRegistry: PriceRegistry;
  staleMinutes: number;
  reserveCredits: (requestId: string, amount: number, priceSnapshotId: string, estimatedProviderCostMicrousd: number) => Promise<boolean>;
  releaseCredits: (requestId: string) => Promise<void>;
}

function messageTextSize(request: ChatCompletionRequest): number {
  return request.messages.reduce((total, message) => {
    if (typeof message.content === "string") return total + message.content.length;
    return total + message.content.reduce((partTotal, part) => partTotal + (part.type === "text" ? part.text.length : 1_000), 0);
  }, 0);
}

function needsVision(request: ChatCompletionRequest): boolean {
  return request.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"));
}

function eligible(candidate: RouteCandidate, request: ChatCompletionRequest): boolean {
  if (!candidate.healthy) return false;
  if (needsVision(request) && !candidate.vision) return false;
  if (request.tools?.length && !candidate.tools) return false;
  const estimatedTokens = Math.ceil(messageTextSize(request) / 3.2) + (request.max_tokens ?? 1_024);
  return candidate.contextWindow >= estimatedTokens;
}

export function diagnoseEligibility(candidate: RouteCandidate, request: ChatCompletionRequest): string {
  if (!candidate.healthy) return "unhealthy_status";
  if (needsVision(request) && !candidate.vision) return "unsupported_vision";
  if (request.tools?.length && !candidate.tools) return "unsupported_tools";
  const estimatedTokens = Math.ceil(messageTextSize(request) / 3.2) + (request.max_tokens ?? 1_024);
  if (candidate.contextWindow < estimatedTokens) return "context_window_exceeded";
  return "provider_rejected_request";
}


export function scoreCandidate(candidate: RouteCandidate): number {
  return (candidate.pinned ? 100_000 : 0) +
    (candidate.free ? 10_000 : 0) +
    (candidate.managed ? 0 : 250) +
    Math.max(0, Math.min(candidate.quality, 100)) * 25 -
    Math.min(candidate.latencyMs, 30_000) / 10;
}

function policyScore(candidate: RouteCandidate, policy: string): number {
  switch (policy) {
    case "fast":
      return Math.max(0, 5000 - candidate.latencyMs) * 10 + candidate.quality;
    case "balanced":
      return candidate.quality * 25 - candidate.latencyMs / 5;
    case "deep":
      return candidate.quality * 50 - candidate.latencyMs / 20;
    default:
      return scoreCandidate(candidate);
  }
}

export function estimateManagedCost(
  candidate: RouteCandidate,
  request: ChatCompletionRequest,
  priceRegistry: PriceRegistry,
): { estimatedCredits: number; warning: string | null } {
  const estimatedInput = Math.ceil(messageTextSize(request) / 3.2);
  const estimatedOutput = request.max_tokens ?? 1024;

  try {
    const estimate = priceRegistry.estimateCost(candidate.provider, candidate.model, estimatedInput, estimatedOutput);
    return { estimatedCredits: estimate.estimatedCredits, warning: null };
  } catch {
    return { estimatedCredits: 0, warning: "No price data available for this route" };
  }
}

export function rankCandidates(candidates: RouteCandidate[], request: ChatCompletionRequest): RouteCandidate[] {
  const requestedProvider = request.hive?.provider;
  const requestedModel = request.hive?.model || (request.model !== HIVE_ROUTER_ID ? request.model : undefined);
  const policy = request.hive?.policy ?? "free-first-balanced";
  return candidates
    .map((candidate) => ({
      ...candidate,
      pinned: candidate.pinned || Boolean(
        (!requestedProvider || candidate.provider === requestedProvider) &&
        (!requestedModel || candidate.model === requestedModel) &&
        (requestedProvider || requestedModel),
      ),
    }))
    .filter((candidate) => eligible(candidate, request))
    .sort((left, right) => policyScore(right, policy) - policyScore(left, policy) || left.id.localeCompare(right.id));
}

function upstreamPayload(request: ChatCompletionRequest, model: string) {
  const { hive: _hive, ...payload } = request;
  return { ...payload, model };
}

function failureReason(status: number): string {
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (status === 402) return "provider_quota_exhausted";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "provider_rejected_request";
}

function parseDurationMs(value: string): number | undefined {
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(/([\d.]+)\s*(ms|s|m|h|d)/gi)) {
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) continue;
    matched = true;
    const unit = match[2]!.toLowerCase();
    total += amount * (unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
  }
  return matched ? total : undefined;
}

function parseResetAt(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric > 10_000_000_000) return numeric;
    if (numeric > 1_000_000_000) return numeric * 1_000;
    return now + numeric * 1_000;
  }
  const duration = parseDurationMs(trimmed);
  if (duration !== undefined) return now + duration;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) && date > now ? date : undefined;
}

function nextUtcDay(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export interface CooldownDirective {
  until: number;
  reason: string;
}

export function cooldownFromResponse(response: Pick<Response, "headers" | "status" | "ok">, now: number, body = ""): CooldownDirective | undefined {
  const dailyRemaining = response.headers.get("x-ratelimit-remaining-requests-day") ?? response.headers.get("x-ratelimit-remaining-tokens-day");
  const dailyReset = response.headers.get("x-ratelimit-reset-requests-day") ?? response.headers.get("x-ratelimit-reset-tokens-day");
  const genericRemaining = response.headers.get("x-ratelimit-remaining") ?? response.headers.get("x-ratelimit-remaining-requests");
  const genericReset = response.headers.get("x-ratelimit-reset") ?? response.headers.get("x-ratelimit-reset-requests");
  const retryAfter = parseResetAt(response.headers.get("retry-after"), now);
  const bodySignalsDailyLimit = /(?:daily|per[ -]?day|requests?[ -]?per[ -]?day|free-models-per-day)/i.test(body);

  if (dailyRemaining?.trim() === "0" || bodySignalsDailyLimit) {
    return { until: parseResetAt(dailyReset, now) ?? nextUtcDay(now), reason: "provider_daily_quota_exhausted" };
  }
  if (response.status === 402) return { until: retryAfter ?? nextUtcDay(now), reason: "provider_quota_exhausted" };
  if (response.status === 401) return { until: now + 5 * 60_000, reason: "provider_auth_failed" };
  if (response.status === 403 && genericRemaining?.trim() !== "0" && !/rate.?limit/i.test(body)) {
    return { until: now + 5 * 60_000, reason: "provider_auth_failed" };
  }
  if (response.status === 429 || response.status === 403 || genericRemaining?.trim() === "0") {
    return { until: retryAfter ?? parseResetAt(genericReset, now) ?? now + 60_000, reason: "provider_rate_limited" };
  }
  if ([408, 409, 425].includes(response.status)) return { until: now + 30_000, reason: "provider_temporarily_unavailable" };
  if (response.status >= 500) return { until: now + 30_000, reason: "provider_unavailable" };
  return undefined;
}

export class HiveRouter {
  readonly #fetch: typeof fetch;
  readonly #customFetch: typeof fetchPublicHttpsEndpoint;
  readonly #validateEndpoint: typeof validatePublicHttpsEndpoint | undefined;
  readonly #now: () => number;
  readonly #requestId: () => string;
  readonly #cooldowns = new Map<string, CooldownDirective>();

  public constructor(options: HiveRouterOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#customFetch = options.customFetch ?? fetchPublicHttpsEndpoint;
    this.#validateEndpoint = options.validateEndpoint;
    this.#now = options.now ?? Date.now;
    this.#requestId = options.requestId ?? randomUUID;
  }

  public async route(
    request: ChatCompletionRequest,
    candidates: RouteCandidate[],
    signal?: AbortSignal,
    managedOptions?: ManagedRouteOptions,
  ): Promise<RouterResult> {
    const requestId = this.#requestId();
    const now = this.#now();
    for (const [id, cooldown] of this.#cooldowns) if (cooldown.until <= now) this.#cooldowns.delete(id);
    const allRanked = rankCandidates(candidates, request);
    if (allRanked.length === 0) {
      const attempts: RouteAttempt[] = candidates.map(candidate => ({
        provider: candidate.provider,
        model: candidate.model,
        status: "skipped",
        reason: diagnoseEligibility(candidate, request),
        latencyMs: 0,
      }));
      const requestedCapability = needsVision(request) ? "vision" : request.tools?.length ? "tools" : "context";
      throw new RouterError("unsupported_capability", `No healthy route satisfies the required ${requestedCapability} capability.`, 422, attempts, requestId);
    }

    const allowFallback = request.hive?.allow_fallback ?? true;
    const cooled = allRanked.filter((candidate) => this.#cooldowns.has(candidate.id));
    if (cooled.length === allRanked.length) {
      const attempts: RouteAttempt[] = cooled.map((candidate) => ({
        provider: candidate.provider,
        model: candidate.model,
        status: "skipped",
        reason: this.#cooldowns.get(candidate.id)?.reason ?? "provider_cooldown",
        latencyMs: 0,
      }));
      throw new RouterError("upstream_error", "Every eligible provider route is cooling down after a quota, rate-limit, authentication, or availability failure.", 429, attempts, requestId);
    }

    const attempts: RouteAttempt[] = [];
    for (const candidate of allRanked) {
      const existingCooldown = this.#cooldowns.get(candidate.id);
      if (existingCooldown) {
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          status: "skipped",
          reason: existingCooldown.reason,
          latencyMs: 0,
        });
        if (!allowFallback) throw new RouterError("upstream_error", "The selected provider route is cooling down.", 429, attempts, requestId);
        continue;
      }
      // Managed routes fail closed unless durable reservation callbacks exist.
      if (candidate.managed && !candidate.free && !managedOptions) {
        attempts.push({ provider: candidate.provider, model: candidate.model, status: "skipped", reason: "managed_billing_unavailable", latencyMs: 0 });
        continue;
      }
      if (candidate.managed && !candidate.free && managedOptions) {
        const { priceRegistry } = managedOptions;

        // Check for stale prices - fail closed
        if (priceRegistry.isStale(candidate.provider, candidate.model, managedOptions.staleMinutes)) {
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            status: "skipped",
            reason: "price_data_stale",
            latencyMs: 0,
          });
          continue;
        }

        // Estimate cost
        const estimatedInput = Math.ceil(messageTextSize(request) / 3.2);
        const estimatedOutput = request.max_tokens ?? 1024;
        let estimate;
        try {
          estimate = priceRegistry.estimateCost(candidate.provider, candidate.model, estimatedInput, estimatedOutput);
        } catch {
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            status: "skipped",
            reason: "no_price_data",
            latencyMs: 0,
          });
          continue;
        }
        const priceSnapshot = priceRegistry.getPrice(candidate.provider, candidate.model);
        if (!priceSnapshot) continue;

        // Reserve credits
        const reserved = await managedOptions.reserveCredits(requestId, estimate.estimatedCredits, priceSnapshot.id, estimate.estimatedProviderCostMicrousd);
        if (!reserved) {
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            status: "skipped",
            reason: "insufficient_credits",
            latencyMs: 0,
          });
          continue;
        }

        // Use the appropriate adapter
        const adapter = candidate.provider === "openai"
          ? new OpenAIAdapter({ apiKey: candidate.apiKey, baseUrl: candidate.baseUrl })
          : candidate.provider === "anthropic"
            ? new AnthropicAdapter({ apiKey: candidate.apiKey, baseUrl: candidate.baseUrl })
            : null;

        if (!adapter) {
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            status: "skipped",
            reason: "unsupported_managed_provider",
            latencyMs: 0,
          });
          await managedOptions.releaseCredits(requestId);
          continue;
        }

        const managedStartedAt = this.#now();
        try {
          const managedPayload = adapter.buildRequest({
            model: candidate.model,
            messages: request.messages as Array<{ role: string; content: unknown }>,
            stream: request.stream ?? false,
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.max_tokens !== undefined ? { max_tokens: request.max_tokens } : {}),
            ...(request.tools !== undefined ? { tools: request.tools } : {}),
          });

          const endpoint = adapter.getEndpoint();
          const headers = adapter.buildHeaders();

          const upstream = await this.#fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(managedPayload),
            redirect: "error",
            ...(signal ? { signal } : {}),
          });

          const latencyMs = Math.max(0, this.#now() - managedStartedAt);

          if (upstream.ok) {
            const normalizedUpstream = adapter instanceof AnthropicAdapter
              ? await adapter.toOpenAIResponse(upstream, request.stream ?? false, candidate.model)
              : upstream;

            const cooldown = cooldownFromResponse(upstream, this.#now());
            if (cooldown) this.#cooldowns.set(candidate.id, cooldown);

            attempts.push({ provider: candidate.provider, model: candidate.model, status: "selected", statusCode: upstream.status, latencyMs });

            return {
              upstream: normalizedUpstream,
              receipt: {
                requestId,
                router: HIVE_ROUTER_ID,
                policy: (request.hive?.policy as RouteReceipt["policy"]) ?? "free-first-balanced",
                provider: candidate.provider,
                model: candidate.model,
                managed: candidate.managed,
                costClass: candidate.managed ? (candidate.free ? "free" : "paid") : "byok",
                fallbackCount: Math.max(0, attempts.length - 1),
                latencyMs,
                priceSnapshotId: priceSnapshot.id,
                reservedCredits: estimate.estimatedCredits,
                estimatedProviderCostMicrousd: estimate.estimatedProviderCostMicrousd,
                attempts,
              },
            };
          } else {
            // Release credits on failure
            await managedOptions.releaseCredits(requestId);

            const errorBody = [402, 403, 429].includes(upstream.status)
              ? await upstream.clone().text().then((v) => v.slice(0, 8192)).catch(() => "")
              : "";
            const cooldown = cooldownFromResponse(upstream, this.#now(), errorBody);
            if (cooldown) this.#cooldowns.set(candidate.id, cooldown);

            attempts.push({
              provider: candidate.provider,
              model: candidate.model,
              status: "failed",
              statusCode: upstream.status,
              reason: cooldown?.reason ?? failureReason(upstream.status),
              latencyMs,
            });
            await upstream.body?.cancel().catch(() => undefined);
            if (!allowFallback || ![401, 402, 403, 408, 409, 425, 429, 500, 502, 503, 504].includes(upstream.status)) break;
          }
        } catch (error) {
          // Release credits on network error
          await managedOptions.releaseCredits(requestId);
          const latencyMs = Math.max(0, this.#now() - managedStartedAt);
          const cancelled = error instanceof Error && error.name === "AbortError";
          if (!cancelled) this.#cooldowns.set(candidate.id, { until: this.#now() + 30_000, reason: "provider_network_error" });
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            status: "failed",
            reason: cancelled ? "request_cancelled" : "provider_network_error",
            latencyMs,
          });
          if (signal?.aborted || !allowFallback) break;
        }
        // Managed route handled; skip the BYOK path below
        continue;
      }
      const startedAt = this.#now();
      try {
        if (candidate.provider === "custom" && this.#validateEndpoint) await this.#validateEndpoint(candidate.baseUrl);
        const adapter = candidate.provider === "openai"
          ? new OpenAIAdapter({ apiKey: candidate.apiKey, baseUrl: candidate.baseUrl })
          : candidate.provider === "anthropic"
            ? new AnthropicAdapter({ apiKey: candidate.apiKey, baseUrl: candidate.baseUrl })
            : undefined;
        const endpoint = adapter ? adapter.getEndpoint() : `${candidate.baseUrl.replace(/\/+$/, "")}/chat/completions`;
        const adapterPayload = adapter ? adapter.buildRequest({
          model: candidate.model,
          messages: request.messages as Array<{ role: string; content: unknown }>,
          stream: request.stream ?? false,
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.max_tokens !== undefined ? { max_tokens: request.max_tokens } : {}),
          ...(request.tools !== undefined ? { tools: request.tools } : {}),
        }) : upstreamPayload(request, candidate.model);
        const requestInit = {
          method: "POST",
          headers: adapter ? adapter.buildHeaders() : {
            authorization: `Bearer ${candidate.apiKey}`,
            "content-type": "application/json",
            accept: request.stream ? "text/event-stream" : "application/json",
            "user-agent": "HIVE-Cloud/0.1",
            ...providerRequestHeaders(candidate.provider),
          },
          body: JSON.stringify(adapterPayload),
          redirect: "error",
          ...(signal ? { signal } : {}),
        } satisfies RequestInit;
        const upstream = candidate.provider === "custom"
          ? await this.#customFetch(endpoint, requestInit, { timeoutMs: 30_000, maxResponseBytes: 20 * 1024 * 1024 })
          : await this.#fetch(endpoint, requestInit);
        const latencyMs = Math.max(0, this.#now() - startedAt);
        if (upstream.ok) {
          const normalizedUpstream = adapter instanceof AnthropicAdapter
            ? await adapter.toOpenAIResponse(upstream, request.stream ?? false, candidate.model)
            : upstream;
          const cooldown = cooldownFromResponse(upstream, this.#now());
          if (cooldown) this.#cooldowns.set(candidate.id, cooldown);
          else this.#cooldowns.delete(candidate.id);
          attempts.push({ provider: candidate.provider, model: candidate.model, status: "selected", statusCode: upstream.status, latencyMs });
          return {
            upstream: normalizedUpstream,
            receipt: {
              requestId,
              router: HIVE_ROUTER_ID,
              policy: (request.hive?.policy as RouteReceipt["policy"]) ?? "free-first-balanced",
              provider: candidate.provider,
              model: candidate.model,
              managed: candidate.managed,
              costClass: candidate.managed ? (candidate.free ? "free" : "paid") : "byok",
              fallbackCount: Math.max(0, attempts.length - 1),
              latencyMs,
              attempts,
            },
          };
        }
        const errorBody = [402, 403, 429].includes(upstream.status)
          ? await upstream.clone().text().then((value) => value.slice(0, 8_192)).catch(() => "")
          : "";
        const cooldown = cooldownFromResponse(upstream, this.#now(), errorBody);
        if (cooldown) this.#cooldowns.set(candidate.id, cooldown);
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          status: "failed",
          statusCode: upstream.status,
          reason: cooldown?.reason ?? failureReason(upstream.status),
          latencyMs,
        });
        await upstream.body?.cancel().catch(() => undefined);
        if (!allowFallback || ![401, 402, 403, 408, 409, 425, 429, 500, 502, 503, 504].includes(upstream.status)) break;
      } catch (error) {
        const latencyMs = Math.max(0, this.#now() - startedAt);
        const cancelled = error instanceof Error && error.name === "AbortError";
        if (!cancelled) this.#cooldowns.set(candidate.id, { until: this.#now() + 30_000, reason: "provider_network_error" });
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          status: "failed",
          reason: cancelled ? "request_cancelled" : "provider_network_error",
          latencyMs,
        });
        if (signal?.aborted || !allowFallback) break;
      }
    }
    throw new RouterError("upstream_error", "Every eligible provider route failed before producing a response.", 502, attempts, requestId);
  }

  public cooldownUntil(candidateId: string): number | undefined {
    const cooldown = this.#cooldowns.get(candidateId);
    if (!cooldown || cooldown.until <= this.#now()) {
      if (cooldown) this.#cooldowns.delete(candidateId);
      return undefined;
    }
    return cooldown.until;
  }
}
