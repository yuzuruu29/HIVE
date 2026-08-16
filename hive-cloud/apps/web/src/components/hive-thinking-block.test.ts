import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildProcessingSteps,
  ChatMessage,
  processingLabel,
  processingStatus,
  type ChatMessageData,
  type ChatRouteReceipt,
} from "./chat-interface";
import {
  formatProcessingDuration,
  HiveThinkingBlock,
  isActiveProcessingStatus,
  safeProcessingErrorLabel,
} from "./hive-thinking-block";
import { CouncilExecutionPanel } from "./council-execution-panel";

const receipt: ChatRouteReceipt = {
  requestId: "req-safe-1",
  provider: "gemini",
  model: "gemini-2.5-flash",
  policy: "free-first-balanced",
  fallbackCount: 0,
  latencyMs: 420,
  attempts: [{ provider: "gemini", model: "gemini-2.5-flash", status: "selected", latencyMs: 420 }],
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

function renderMessage(message: ChatMessageData, streaming = message.status === "streaming") {
  return renderToStaticMarkup(React.createElement(ChatMessage, {
    message,
    latest: true,
    streaming,
    lastUser: "Try again",
    onEdit: () => undefined,
    onRegenerate: () => undefined,
    onRetry: () => undefined,
    onReceipt: () => undefined,
    onCancel: () => undefined,
  }));
}

describe("HIVE processing disclosure", () => {
  it("appears immediately for an optimistic assistant message", () => {
    const markup = renderMessage(assistant());
    expect(markup).toContain("hive-thinking-block");
    expect(markup).toContain("HIVE is selecting an eligible route");
  });

  it("shows the accurate queued label", () => {
    const message = assistant({ processingStage: "queued", processing: { status: "queued", startedAt: "2026-07-16T10:00:00.000Z" } });
    expect(processingLabel(message, processingStatus(message))).toBe("Queen received your request");
  });

  it("uses a native disclosure button with expanded semantics", () => {
    const markup = renderMessage(assistant());
    expect(markup).toMatch(/<button[^>]+aria-expanded="false"[^>]+aria-controls=/);
  });

  it("runs elapsed timers only for active states", () => {
    expect(isActiveProcessingStatus("routing")).toBe(true);
    expect(isActiveProcessingStatus("streaming")).toBe(true);
    expect(isActiveProcessingStatus("completed")).toBe(false);
    expect(isActiveProcessingStatus("cancelled")).toBe(false);
    expect(isActiveProcessingStatus("failed")).toBe(false);
  });

  it("maps the first-token wait to streaming when content arrives", () => {
    const waiting = assistant({ processingStage: "waiting-first-token", processing: { status: "waiting-first-token", startedAt: "2026-07-16T10:00:00.000Z" }, routeReceipt: receipt });
    const streaming = assistant({ content: "Hello", processingStage: "streaming", processing: { status: "streaming", startedAt: "2026-07-16T10:00:00.000Z" }, routeReceipt: receipt });
    expect(processingStatus(waiting)).toBe("waiting-first-token");
    expect(processingStatus(streaming)).toBe("streaming");
  });

  it("removes waiting dots after the first token", () => {
    const waitingMarkup = renderMessage(assistant({ processingStage: "waiting-first-token", processing: { status: "waiting-first-token", startedAt: "2026-07-16T10:00:00.000Z" }, routeReceipt: receipt }));
    const streamingMarkup = renderMessage(assistant({ content: "Hello", processingStage: "streaming", processing: { status: "streaming", startedAt: "2026-07-16T10:00:00.000Z" }, routeReceipt: receipt }));
    expect(waitingMarkup).toContain("ai-bouncing-dots");
    expect(streamingMarkup).not.toContain("ai-bouncing-dots");
  });

  it("renders completed history as a collapsed summary", () => {
    const message = assistant({ content: "Done", status: "complete", routeReceipt: { ...receipt, executionSummary: { status: "completed", startedAt: "2026-07-16T10:00:00.000Z", completedAt: "2026-07-16T10:00:04.200Z", durationMs: 4200 } }, processing: undefined });
    const markup = renderMessage(message, false);
    expect(markup).toContain('data-status="completed"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("4.2s");
  });

  it("stops animations for cancellation", () => {
    const markup = renderMessage(assistant({ status: "cancelled", processingStage: "cancelled", processing: { status: "cancelled", startedAt: "2026-07-16T10:00:00.000Z", completedAt: "2026-07-16T10:00:01.000Z" } }), false);
    expect(markup).toContain("Request cancelled");
    expect(markup).not.toContain("ai-shimmer-text");
    expect(markup).not.toContain("ai-bouncing-dots");
  });

  it("keeps failures expanded with controlled information", () => {
    const markup = renderMessage(assistant({ status: "failed", processingStage: "failed", processing: { status: "failed", startedAt: "2026-07-16T10:00:00.000Z", errorCode: "no_route" } }), false);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("No eligible route is available");
  });

  it("adds search steps only when Search was active", () => {
    expect(buildProcessingSteps(assistant(), "routing").some((step) => step.id === "search")).toBe(false);
    const research = assistant({ processing: { status: "searching", startedAt: "2026-07-16T10:00:00.000Z", searchActive: true } });
    expect(buildProcessingSteps(research, "searching").find((step) => step.id === "search")?.status).toBe("active");
  });

  it("reports citations only when normalized citations exist", () => {
    const research = assistant({ processing: { status: "routing", startedAt: "2026-07-16T10:00:00.000Z", searchActive: true, citationCount: 5 } });
    expect(buildProcessingSteps(research, "routing").find((step) => step.id === "search")?.label).toBe("Retrieved 5 cited sources");
  });

  it("adds file preparation only after prepared files are present", () => {
    expect(buildProcessingSteps(assistant(), "routing").some((step) => step.id === "files")).toBe(false);
    const withFiles = assistant({ processing: { status: "routing", startedAt: "2026-07-16T10:00:00.000Z", preparedFileCount: 2 } });
    expect(buildProcessingSteps(withFiles, "routing").find((step) => step.id === "files")?.label).toBe("Prepared 2 attached files");
  });

  it("shows route metadata only after a route is selected", () => {
    expect(renderMessage(assistant())).not.toContain("gemini-2.5-flash");
    expect(renderMessage(assistant({ routeReceipt: receipt, processingStage: "waiting-first-token", processing: { status: "waiting-first-token", startedAt: "2026-07-16T10:00:00.000Z" } }))).toContain("gemini-2.5-flash");
  });

  it("keeps safe retry attempts visible", () => {
    const retryReceipt = { ...receipt, fallbackCount: 1, attempts: [
      { provider: "groq", model: "model-a", status: "failed" as const, latencyMs: 100, reason: "provider_rate_limited" },
      { provider: "gemini", model: "gemini-2.5-flash", status: "selected" as const, latencyMs: 420 },
    ] };
    const steps = buildProcessingSteps(assistant({ routeReceipt: retryReceipt }), "retrying");
    expect(steps.find((step) => step.id === "attempt-0")?.detail).toBe("Provider rate limit reached");
    expect(steps.find((step) => step.id === "attempt-1")?.status).toBe("completed");
  });

  it("never renders hidden reasoning fields", () => {
    const message = { ...assistant(), hiddenReasoning: "private chain of thought", internalPrompt: "secret prompt" } as ChatMessageData;
    const markup = renderMessage(message);
    expect(markup).not.toContain("private chain of thought");
    expect(markup).not.toContain("secret prompt");
  });

  it("never renders unknown raw errors or secrets", () => {
    expect(safeProcessingErrorLabel("Bearer sk-secret-value")).toBe("HIVE could not complete the request");
    const markup = renderMessage(assistant({ status: "failed", processing: { status: "failed", startedAt: "2026-07-16T10:00:00.000Z", errorCode: "Bearer sk-secret-value" } }), false);
    expect(markup).not.toContain("sk-secret-value");
  });

  it("retains readable reduced-motion styles", () => {
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".ai-pulse-ring-orbit");
    expect(css).toContain("animation: none");
  });

  it("does not create processing blocks for older messages without metadata", () => {
    const markup = renderMessage(assistant({ content: "Old answer", status: "complete", processing: undefined, processingStage: undefined, routeReceipt: undefined }), false);
    expect(markup).not.toContain("hive-thinking-block");
    expect(markup).toContain("Old answer");
  });

  it("preserves editing and regeneration controls", () => {
    expect(renderMessage(assistant({ content: "Answer", status: "complete", processing: undefined }), false)).toContain("Regenerate");
    const userMarkup = renderMessage({ id: "user-1", role: "user", content: "Question", status: "complete" }, false);
    expect(userMarkup).toContain("Edit");
  });

  it("renders a Retry button on a failed assistant message", () => {
    const markup = renderMessage(assistant({ status: "failed", processingStage: "failed", processing: { status: "failed", startedAt: "2026-07-16T10:00:00.000Z", errorCode: "upstream_error" } }), false);
    expect(markup).toContain("Retry");
  });

  it("renders a Retry button on a cancelled assistant message", () => {
    const markup = renderMessage(assistant({ status: "cancelled", processingStage: "cancelled", processing: { status: "cancelled", startedAt: "2026-07-16T10:00:00.000Z", completedAt: "2026-07-16T10:00:01.000Z" } }), false);
    expect(markup).toContain("Retry");
  });

  it("does not render a Retry button on a completed assistant message", () => {
    const markup = renderMessage(assistant({ content: "Done", status: "complete", processing: undefined }), false);
    expect(markup).not.toContain("Retry");
  });

  it("does not render a Retry button on a streaming assistant message", () => {
    const markup = renderMessage(assistant({ content: "Partial", status: "streaming" }));
    expect(markup).not.toContain("Retry");
  });

  it("leaves the Build Council timeline available", () => {
    const markup = renderToStaticMarkup(React.createElement(CouncilExecutionPanel, {
      overallState: "Council active",
      completedCount: 0,
      totalCount: 1,
      isBusy: true,
      phases: [{ id: "queen", role: "queen", name: "queen", action: "Routes the objective", status: "active" }],
    }));
    expect(markup).toContain("council-execution-panel");
    expect(markup).toContain("Routes the objective");
  });

  it("keeps mobile controls touch-sized and metadata wrapping", () => {
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    expect(css).toContain("@media (max-width: 520px)");
    expect(css).toContain("min-height: 44px");
    expect(css).toContain("overflow-wrap: anywhere");
  });

  it("formats compact elapsed durations without using provider latency", () => {
    expect(formatProcessingDuration(800)).toBe("0.8s");
    expect(formatProcessingDuration(4_200)).toBe("4.2s");
    expect(formatProcessingDuration(73_000)).toBe("1m 13s");
  });

  it("forwards browser cancellation through the cloud proxy", () => {
    const proxySource = readFileSync(new URL("../app/api/cloud/[...path]/route.ts", import.meta.url), "utf8");
    expect(proxySource).toContain("signal: request.signal");
    const chatSource = readFileSync(new URL("./chat-surface.tsx", import.meta.url), "utf8");
    expect(chatSource).toContain("/cancel");
    expect(chatSource).toContain("idempotency_key");
  });

  it("renders a reusable standalone disclosure", () => {
    const markup = renderToStaticMarkup(React.createElement(HiveThinkingBlock, {
      status: "completed",
      label: "Response complete",
      steps: [{ id: "done", label: "Response completed", status: "completed" }],
      elapsedMs: 1200,
    }));
    expect(markup).toContain("Execution summary");
    expect(markup).toContain("1.2s");
  });
});
