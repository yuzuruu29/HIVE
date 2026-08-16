import { describe, expect, it } from "vitest";
import { chatCompletionRequestSchema } from "./index.js";

const request = (url: string) => ({
  model: "hive-0.1",
  messages: [{ role: "user", content: "hello" }],
  hive: { citations: [{ title: "Source", url, retrieved_at: "2026-07-18T08:00:00.000Z" }] },
});

describe("internal HIVE citations", () => {
  it.each(["https://example.com/a", "http://example.com/b"])("accepts %s", (url) => {
    expect(chatCompletionRequestSchema.parse(request(url)).hive?.citations?.[0]?.url).toBe(url);
  });

  it.each(["javascript:alert(1)", "data:text/html,test", "ftp://example.com/file"])("rejects %s", (url) => {
    expect(() => chatCompletionRequestSchema.parse(request(url))).toThrow();
  });
});
