// @vitest-environment jsdom
import React from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ChatMessage, type ChatMessageData } from "./chat-interface";

const receipt = {
  requestId: "req-safe-1",
  provider: "gemini",
  model: "gemini-2.5-flash",
  policy: "free-first-balanced",
  fallbackCount: 0,
  latencyMs: 420,
  attempts: [{ provider: "gemini", model: "gemini-2.5-flash", status: "selected" as const, latencyMs: 420 }],
};

function assistant(overrides: Partial<ChatMessageData> = {}): ChatMessageData {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "",
    status: "streaming",
    processingStage: "routing",
    processing: { status: "routing", startedAt: "2026-07-16T10:00:00.000Z" },
    ...overrides,
  };
}

describe("HIVE thinking block interactive", () => {
  it("calls onRetry with the message id when Retry is clicked", () => {
    const onRetry = vi.fn();
    const failedMessage = assistant({ id: "msg-failed-1", status: "failed", processingStage: "failed", processing: { status: "failed", startedAt: "2026-07-16T10:00:00.000Z", errorCode: "upstream_error" } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => {
      root.render(React.createElement(ChatMessage, {
        message: failedMessage,
        latest: true,
        streaming: false,
        lastUser: "Hello",
        onEdit: () => undefined,
        onRegenerate: () => undefined,
        onRetry,
        onReceipt: () => undefined,
        onCancel: () => undefined,
      }));
    });
    const retryButton = Array.from(container.querySelectorAll("button.message-tool")).find((btn) => btn.textContent?.includes("Retry"));
    expect(retryButton).toBeTruthy();
    (retryButton as HTMLElement).click();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith("msg-failed-1");
    flushSync(() => root.unmount());
    container.remove();
  });

  it("renders citations inside the assistant message that owns them", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(React.createElement(ChatMessage, {
      message: assistant({ status: "complete", content: "Answer", citations: [{ title: "Example source", url: "https://example.com/source", retrievedAt: "2026-07-18T08:00:00.000Z" }] }),
      latest: true, streaming: false, onEdit: () => undefined, onRegenerate: () => undefined, onReceipt: () => undefined,
    })));
    expect(container.querySelector('.message .source-group a')?.getAttribute("href")).toBe("https://example.com/source");
    expect(container.textContent).toContain("Example source");
    flushSync(() => root.unmount());
    container.remove();
  });
});
