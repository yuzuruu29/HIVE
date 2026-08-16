import { describe, it, expect } from "vitest";
import { AnthropicAdapter } from "./anthropic-adapter.js";

describe("AnthropicAdapter", () => {
  const adapter = new AnthropicAdapter({ apiKey: "sk-ant-test" });

  it("builds correct request payload with system message extraction", () => {
    const payload = adapter.buildRequest({
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 4096,
      stream: true,
    });

    expect(payload.model).toBe("claude-sonnet-4-20250514");
    expect(payload.system).toBe("You are helpful");
    expect(payload.messages).toHaveLength(1);
    expect((payload.messages as Array<{ role: string }>)[0]!.role).toBe("user");
  });

  it("normalizes content_block_delta events", () => {
    const result = adapter.normalizeEvent({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hello" },
    });
    expect(result.content).toBe("Hello");
    expect(result.finishReason).toBeUndefined();
  });

  it("detects stop reason from message_stop event", () => {
    const result = adapter.normalizeEvent({ type: "message_stop" });
    expect(result.finishReason).toBe("end_turn");
  });

  it("extracts usage from message_delta event", () => {
    const usage = adapter.extractUsage({
      type: "message_delta",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 20,
      },
    });
    expect(usage.promptTokens).toBe(100);
    expect(usage.completionTokens).toBe(50);
    expect(usage.cacheWriteTokens).toBe(10);
    expect(usage.cacheHitTokens).toBe(20);
  });

  it("returns empty content for non-content events", () => {
    expect(adapter.normalizeEvent({ type: "ping" }).content).toBe("");
    expect(adapter.normalizeEvent({ type: "message_start" }).content).toBe("");
  });

  it("throws for missing API key", () => {
    expect(() => new AnthropicAdapter({ apiKey: "" })).toThrow("API key is required");
  });

  it("builds correct headers with anthropic-version", () => {
    const adapter = new AnthropicAdapter({ apiKey: "sk-ant-test" });
    const headers = adapter.buildHeaders();
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });
});
