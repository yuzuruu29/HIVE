import { describe, expect, it, vi } from "vitest";
import { HIVE_ROUTER_ID, type ChatCompletionRequest, type RouteCandidate } from "@hive-cloud/contracts";
import {
  FreeModelDirectory,
  HiveRouter,
  RouterError,
  cooldownFromResponse,
  managedCandidatesFromEnv,
  rankCandidates,
} from "./index.js";
import { PriceRegistry } from "./price-registry.js";

const request: ChatCompletionRequest = {
  model: HIVE_ROUTER_ID,
  messages: [{ role: "user", content: "Explain the route." }],
  stream: false,
};

function candidate(overrides: Partial<RouteCandidate>): RouteCandidate {
  return {
    id: "provider-a",
    provider: "groq",
    providerName: "Groq",
    model: "llama",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKey: "secret",
    managed: false,
    free: false,
    healthy: true,
    latencyMs: 300,
    quality: 80,
    contextWindow: 32_768,
    vision: false,
    tools: true,
    ...overrides,
  };
}

describe("free-first balanced ranking", () => {
  it("prefers an eligible free route and honors an explicit pin", () => {
    const paid = candidate({ id: "paid", quality: 99 });
    const free = candidate({ id: "free", provider: "openrouter", free: true, quality: 70 });
    expect(rankCandidates([paid, free], request)[0]?.id).toBe("free");
    expect(rankCandidates([paid, free], { ...request, hive: { provider: "groq", allow_fallback: true, policy: "free-first-balanced" } })[0]?.id).toBe("paid");
  });

  it("filters routes that cannot handle image content", () => {
    const visionRequest: ChatCompletionRequest = {
      ...request,
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }] }],
    };
    expect(rankCandidates([candidate({ vision: false })], visionRequest)).toHaveLength(0);
  });
});

describe("router fallback", () => {
  it("falls back on an upstream 429 before returning a stream", async () => {
    const calls: string[] = [];
    const router = new HiveRouter({
      fetch: async (url) => {
        calls.push(String(url));
        return calls.length === 1 ? new Response("limited", { status: 429 }) : Response.json({ id: "ok" });
      },
      requestId: () => "request-1",
    });
    const result = await router.route(request, [
      candidate({ id: "free", free: true }),
      candidate({ id: "paid", provider: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1" }),
    ]);
    expect(result.receipt.fallbackCount).toBe(1);
    expect(result.receipt.attempts[0]?.reason).toBe("provider_rate_limited");
    expect(calls).toHaveLength(2);
  });

  it("returns a structured no-route capability error", async () => {
    const router = new HiveRouter();
    await expect(router.route({ ...request, tools: [{ type: "function", function: { name: "x", parameters: {} } }] }, [candidate({ tools: false })]))
      .rejects.toMatchObject({ code: "unsupported_capability", statusCode: 422 } satisfies Partial<RouterError>);
  });

  it("keeps a rate-limited route on cooldown across requests", async () => {
    let now = 1_000;
    const calls: string[] = [];
    const router = new HiveRouter({
      now: () => now,
      fetch: async (url) => {
        calls.push(String(url));
        return String(url).includes("groq")
          ? new Response("limited", { status: 429, headers: { "retry-after": "60" } })
          : Response.json({ id: "ok" });
      },
    });
    const routes = [
      candidate({ id: "groq", free: true }),
      candidate({ id: "nvidia", provider: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1" }),
    ];

    await router.route(request, routes);
    const second = await router.route(request, routes);
    expect(second.receipt.attempts[0]).toMatchObject({ provider: "groq", status: "skipped", reason: "provider_rate_limited" });
    expect(calls.filter((url) => url.includes("groq"))).toHaveLength(1);

    now += 60_001;
    await router.route(request, routes);
    expect(calls.filter((url) => url.includes("groq"))).toHaveLength(2);
  });

  it("uses daily reset headers when a provider reports an exhausted daily quota", () => {
    const now = Date.UTC(2026, 6, 18, 2, 0, 0);
    const cooldown = cooldownFromResponse(new Response(null, {
      status: 200,
      headers: {
        "x-ratelimit-remaining-requests-day": "0",
        "x-ratelimit-reset-requests-day": "2h",
      },
    }), now);
    expect(cooldown).toEqual({ until: now + 2 * 60 * 60 * 1_000, reason: "provider_daily_quota_exhausted" });
  });
});

describe("free provider catalog", () => {
  it("loads all documented OpenCode free chat models as local BYOK routes", () => {
    const candidates = managedCandidatesFromEnv({ OPENCODE_API_KEY: "opencode-secret", HIVE_LOCAL_PROVIDER_BRIDGE: "true" });
    expect(candidates.map((item) => item.model)).toEqual(expect.arrayContaining([
      "big-pickle",
      "deepseek-v4-flash-free",
      "mimo-v2.5-free",
      "north-mini-code-free",
      "nemotron-3-ultra-free",
    ]));
    expect(candidates.every((item) => item.free && !item.managed)).toBe(true);
  });

  it("refreshes OpenCode availability and Nous free recommendations without credentials", async () => {
    const directory = new FreeModelDirectory({
      fetch: async (url) => String(url).includes("opencode")
        ? Response.json({ data: [{ id: "mimo-v2.5-free" }, { id: "paid-model" }] })
        : Response.json({ freeRecommendedModels: [{ modelName: "provider/live:free", displayName: "Live Free", contextLength: 64_000, isVisionModel: true }] }),
    });
    await directory.refresh();
    const candidates = directory.candidatesFromEnv({ OPENCODE_API_KEY: "opencode-secret", NOUS_API_KEY: "nous-secret" });
    expect(candidates.filter((item) => item.provider === "opencode").map((item) => item.model)).toEqual(["mimo-v2.5-free"]);
    expect(candidates.find((item) => item.provider === "nous")).toMatchObject({ model: "provider/live:free", vision: true });
  });
});

describe("managed routing with credit settlement", () => {
  it("routes through managed OpenAI candidate and estimates cost", async () => {
    const priceRegistry = new PriceRegistry();
      priceRegistry.loadSnapshot({
        id: "price-openai",
        provider: "openai",
        model: "gpt-4.1-mini",
        inputMicrousdPerMillionTokens: 1_000_000,
        outputMicrousdPerMillionTokens: 4_000_000,
      sourceUrl: "https://developers.openai.com/api/docs/models",
      effectiveFrom: new Date().toISOString(),
    });

      const reserveCredits = vi.fn().mockResolvedValue(true);
      const releaseCredits = vi.fn().mockResolvedValue(undefined);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        choices: [{ message: { content: "Hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      text: async () => "",
      clone() { return this; },
      body: null,
    }) as unknown as typeof fetch;

    const router = new HiveRouter({ fetch: mockFetch });

    const candidates: RouteCandidate[] = [{
      id: "openai-managed",
      provider: "openai" as RouteCandidate["provider"],
      providerName: "Managed OpenAI",
      model: "gpt-4.1-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-platform-key",
      managed: true,
      free: false,
      healthy: true,
      latencyMs: 200,
      quality: 95,
      contextWindow: 128000,
      vision: true,
      tools: true,
    }];

    const request: ChatCompletionRequest = {
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
      hive: { allow_fallback: false, policy: "free-first-balanced" },
    };

      const result = await router.route(request, candidates, undefined, {
        priceRegistry,
        staleMinutes: 15,
        reserveCredits,
        releaseCredits,
      });

      expect(result.receipt.managed).toBe(true);
      expect(result.receipt.costClass).toBe("paid");
      expect(result.receipt.priceSnapshotId).toBe("price-openai");
      expect(reserveCredits).toHaveBeenCalledOnce();
  });

  it("skips managed route when credits are insufficient", async () => {
    const priceRegistry = new PriceRegistry();
      priceRegistry.loadSnapshot({
        id: "price-openai",
      provider: "openai",
      model: "gpt-4.1-mini",
        inputMicrousdPerMillionTokens: 1_000_000,
        outputMicrousdPerMillionTokens: 4_000_000,
      sourceUrl: "https://developers.openai.com/api/docs/models",
      effectiveFrom: new Date().toISOString(),
    });

      const router = new HiveRouter();

    const candidates: RouteCandidate[] = [{
      id: "openai-managed",
      provider: "openai" as RouteCandidate["provider"],
      providerName: "Managed OpenAI",
      model: "gpt-4.1-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-platform-key",
      managed: true,
      free: false,
      healthy: true,
      latencyMs: 200,
      quality: 95,
      contextWindow: 128000,
      vision: true,
      tools: true,
    }];

    const request: ChatCompletionRequest = {
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
      hive: { allow_fallback: false, policy: "free-first-balanced" },
    };

    await expect(
        router.route(request, candidates, undefined, {
          priceRegistry,
          staleMinutes: 15,
          reserveCredits: vi.fn().mockResolvedValue(false),
          releaseCredits: vi.fn().mockResolvedValue(undefined),
        }),
    ).rejects.toThrow();
  });
});

describe("routing policies", () => {
  it("free-first-balanced policy prefers high-quality candidates over low-latency", () => {
    const fastCandidate: RouteCandidate = {
      id: "fast",
      provider: "groq" as RouteCandidate["provider"],
      providerName: "Fast Provider",
      model: "fast-model",
      baseUrl: "https://fast.example.com/v1",
      apiKey: "key",
      managed: false,
      free: true,
      healthy: true,
      latencyMs: 100,
      quality: 60,
      contextWindow: 32000,
      vision: false,
      tools: false,
    };

    const slowCandidate: RouteCandidate = {
      ...fastCandidate,
      id: "slow",
      providerName: "Slow Provider",
      latencyMs: 5000,
      quality: 90,
    };

    const request: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
      hive: { policy: "free-first-balanced", allow_fallback: false },
    };

    const ranked = rankCandidates([slowCandidate, fastCandidate], request);
    expect(ranked[0]!.id).toBe("slow");
  });

  it("free-first-balanced policy still prefers high-quality candidates", () => {
    const lowQuality: RouteCandidate = {
      id: "lowq",
      provider: "groq" as RouteCandidate["provider"],
      providerName: "LowQ Provider",
      model: "lowq-model",
      baseUrl: "https://lowq.example.com/v1",
      apiKey: "key",
      managed: false,
      free: true,
      healthy: true,
      latencyMs: 100,
      quality: 40,
      contextWindow: 32000,
      vision: false,
      tools: false,
    };

    const highQuality: RouteCandidate = {
      ...lowQuality,
      id: "highq",
      providerName: "HighQ Provider",
      latencyMs: 3000,
      quality: 95,
    };

    const request: ChatCompletionRequest = {
      model: "test",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
      hive: { policy: "free-first-balanced", allow_fallback: false },
    };

    const ranked = rankCandidates([lowQuality, highQuality], request);
    expect(ranked[0]!.id).toBe("highq");
  });
});
