import { describe, it, expect } from "vitest";
import { OpenAIAdapter } from "./openai-adapter.js";

describe("OpenAIAdapter", () => {
  it("builds correct request payload", () => {
    const adapter = new OpenAIAdapter({ apiKey: "sk-test" });
    const payload = adapter.buildRequest({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    });

    expect(payload.model).toBe("gpt-4.1-mini");
    expect(payload.messages).toHaveLength(1);
  });

  it("normalizes streaming response chunks", () => {
    const adapter = new OpenAIAdapter({ apiKey: "sk-test" });

    const streamChunk = {
      id: "chatcmpl-123",
      object: "chat.completion.chunk",
      choices: [{ delta: { content: "Hello" }, index: 0 }],
      usage: null,
    };

    const normalized = adapter.normalizeChunk(streamChunk);
    expect(normalized.content).toBe("Hello");
    expect(normalized.finishReason).toBeUndefined();
  });

  it("extracts usage from final chunk", () => {
    const adapter = new OpenAIAdapter({ apiKey: "sk-test" });

    const finalChunk = {
      id: "chatcmpl-123",
      choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    };

    const usage = adapter.extractUsage(finalChunk);
    expect(usage.promptTokens).toBe(100);
    expect(usage.completionTokens).toBe(50);
    expect(usage.cacheHitTokens).toBe(20);
  });

  it("handles error responses", () => {
    const adapter = new OpenAIAdapter({ apiKey: "sk-test" });
    const error = adapter.normalizeError({ error: { message: "Rate limit exceeded" } }, 429);
    expect(error.code).toBe("provider_rate_limited");
    expect(error.statusCode).toBe(429);
  });

  it("throws for missing API key", () => {
    expect(() => new OpenAIAdapter({ apiKey: "" })).toThrow("API key is required");
  });

  it("builds correct headers", () => {
    const adapter = new OpenAIAdapter({ apiKey: "sk-test" });
    const headers = adapter.buildHeaders();
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("uses custom base URL when provided", () => {
    const adapter = new OpenAIAdapter({ apiKey: "sk-test", baseUrl: "https://custom.openai.com/v1" });
    expect(adapter.getEndpoint()).toBe("https://custom.openai.com/v1/chat/completions");
  });
});
