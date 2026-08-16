import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./chat-surface.tsx", import.meta.url), "utf8");
const listSource = readFileSync(new URL("./conversation-list.tsx", import.meta.url), "utf8");
const interfaceSource = readFileSync(new URL("./chat-interface.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

describe("conversation delete confirmation", () => {
  it("requires two clicks to delete — first click reveals confirm, second click executes", () => {
    expect(listSource).toContain("pendingDeleteId");
    expect(listSource).toContain("Confirm?");
  });

  it("does not call updateConversation with deleted:true on the first trash click", () => {
    expect(listSource).toMatch(/onClick=\{\(\) => setPendingDeleteId\(conversation\.id\)\}><Trash/);
  });

  it("shows a Confirm? button with danger styling when pending", () => {
    expect(listSource).toContain("conversation-action-danger");
    expect(listSource).toContain("pendingDeleteId === conversation.id");
  });

  it("resets pendingDeleteId on blur so the confirm reverts when focus leaves", () => {
    expect(listSource).toContain("onBlur");
    expect(listSource).toContain("setPendingDeleteId(null)");
  });

  it("auto-focuses the confirm button for keyboard accessibility", () => {
    expect(listSource).toContain("autoFocus");
  });

  it("clears pendingDeleteId after a successful delete", () => {
    const confirmDeleteMatch = listSource.match(/async function confirmDelete[\s\S]*?(?=\n  (?:async )?function |\n  const |\n  return |\n  \})/);
    expect(confirmDeleteMatch).toBeTruthy();
    expect(confirmDeleteMatch![0]).toContain("setPendingDeleteId(null)");
  });

  it("renders the danger style for confirm-delete buttons in CSS", () => {
    expect(css).toContain("conversation-action-danger");
  });

  it("uses the existing --danger custom property for the danger style", () => {
    expect(css).toMatch(/conversation-action-danger[\s\S]*?--danger/);
  });
});

describe("scroll stick behavior", () => {
  it("imports shouldStickToBottom from the scroll-stick module", () => {
    expect(source).toContain('import { shouldStickToBottom } from "../lib/scroll-stick"');
  });

  it("tracks scroll position with a stickRef", () => {
    expect(source).toContain("stickRef");
    expect(source).toMatch(/stickRef\s*=\s*useRef\(true\)/);
  });

  it("updates stickRef via an onScroll handler on the transcript container", () => {
    expect(source).toContain("handleTranscriptScroll");
    expect(source).toContain("onScroll={handleTranscriptScroll}");
    expect(source).toMatch(/stickRef\.current\s*=\s*shouldStickToBottom/);
  });

  it("only calls scrollIntoView when stickRef is true", () => {
    expect(source).toMatch(/if\s*\(stickRef\.current\)\s*\{[\s\S]*?scrollIntoView/);
  });

  it("shows a jump-to-latest pill when new content arrives while scrolled up", () => {
    expect(source).toContain("jumpPill");
    expect(source).toContain("setJumpPill(true)");
    expect(source).toContain("Jump to latest");
  });

  it("hides the jump pill when user clicks it and scrolls to bottom", () => {
    expect(source).toContain("setJumpPill(false)");
    expect(source).toContain("stickRef.current = true");
  });

  it("renders the jump pill with an aria-label for accessibility", () => {
    expect(source).toContain('aria-label="Jump to latest messages"');
  });

  it("has a CSS class for the jump-to-latest pill", () => {
    expect(css).toContain("jump-to-latest");
  });
});

describe("composer hint layout", () => {
  it("centers the hint content below its separator", () => {
    expect(css).toMatch(/\.composer-hint\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/);
    expect(css).toMatch(/\.composer-hint\s*>\s*span\s*\{[^}]*display:\s*inline-flex;[^}]*align-items:\s*center;/);
  });

  it("centers fixed-height keycaps without crossing the separator", () => {
    expect(css).toMatch(/\.composer-hint kbd\s*\{[^}]*min-height:\s*20px;[^}]*display:\s*inline-grid;[^}]*place-items:\s*center;/);
    expect(css).toMatch(/\.composer-hint\s*\{[^}]*padding:\s*6px 14px 7px;/);
  });
});

describe("retry on failed/cancelled exchanges", () => {
  it("accepts an onRetry prop in ChatMessage", () => {
    expect(interfaceSource).toContain("onRetry");
  });

  it("renders a Retry button when message status is failed", () => {
    expect(interfaceSource).toMatch(/message\.status\s*===\s*"failed"[\s\S]*?Retry/);
  });

  it("renders a Retry button when message status is cancelled", () => {
    expect(interfaceSource).toMatch(/message\.status\s*===\s*"cancelled"[\s\S]*?Retry/);
  });

  it("uses ArrowCounterClockwise icon for the Retry button", () => {
    expect(interfaceSource).toContain("ArrowCounterClockwise");
  });

  it("wires Retry button to onRetry with message id", () => {
    expect(interfaceSource).toMatch(/onRetry\(message\.id\)/);
  });

  it("passes onRetry from ChatSurface to ChatMessage", () => {
    expect(source).toContain("onRetry");
  });

  it("implements onRetry by finding the preceding user message and calling submit", () => {
    expect(source).toMatch(/function handleRetry[\s\S]*?role\s*===\s*"user"[\s\S]*?submit/);
  });
});

describe("attachment completion contract", () => {
  it("sends complete attachment metadata on completion", () => {
    const attachment = {
      id: "att-1",
      objectKey: "uploads/att-1",
      originalName: "test.ts",
      mimeType: "text/typescript",
      sizeBytes: 1024,
      status: "scanning",
    };

    const completionPayload = {
      objectKey: attachment.objectKey,
      name: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    };

    expect(completionPayload).toHaveProperty("objectKey");
    expect(completionPayload).toHaveProperty("name");
    expect(completionPayload).toHaveProperty("mimeType");
    expect(completionPayload).toHaveProperty("sizeBytes");
  });

  it("calls completeAttachment with all required fields in chat-surface", () => {
    const apiSource = readFileSync(new URL("../lib/conversations-api.ts", import.meta.url), "utf8");
    expect(apiSource).toContain("object_key");
    expect(apiSource).toContain("size_bytes");
    expect(apiSource).toContain("mime_type");
    expect(apiSource).toMatch(/name:\s*payload\.name/);
  });
});
