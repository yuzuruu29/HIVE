import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopChatConversation } from "../../../../../src/desktop/types";
import { ChatStream } from "./ChatStream";

const now = "2026-08-17T00:00:00.000Z";

const conversation: DesktopChatConversation = {
  id: "chat-1789200000000-ab12",
  cwd: "C:\\HIVE",
  role: "auto",
  ground: false,
  createdAt: now,
  updatedAt: now,
  messages: [
    { id: "msg-0", role: "user", content: "Write a hello function", at: now },
    {
      id: "msg-1",
      role: "assistant",
      content: "Here is `hello()`:\n\n```ts\nfunction hello() {}\n```",
      at: now,
      receipt: { role: "coding", providerId: "ollama", model: "qwen3", source: "role-assignment", degraded: false, promptTokens: 10, completionTokens: 20, totalTokens: 30, latencyMs: 1_250 },
    },
  ],
};

describe("ChatStream", () => {
  it("renders a polite log with completed messages and truthful receipt chips", () => {
    render(<ChatStream conversation={conversation} streaming={undefined} disabled={false} onRetry={() => {}} repositoryRoot="C:\HIVE" onOpenArtifacts={() => {}} />);
    expect(screen.getByRole("log", { name: /conversation messages/i })).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("Write a hello function")).toBeInTheDocument();
    expect(document.querySelector(".code-block .block-code")).toBeInTheDocument();
    expect(screen.getByText(/coding -> ollama\/qwen3 - 30 tok - 1\.3s/)).toBeInTheDocument();
  });

  it("shows the typing loader before the first chunk and the caret while streaming", () => {
    const { rerender } = render(<ChatStream conversation={conversation} streaming={{ turnId: "turn-a-1", text: "" }} disabled route={{ providerId: "ollama", model: "qwen3", source: "role-assignment", degraded: false }} onRetry={() => {}} repositoryRoot="C:\HIVE" onOpenArtifacts={() => {}} />);
    expect(screen.getByLabelText(/hive is thinking/i)).toBeInTheDocument();
    expect(screen.getByText(/auto -> ollama\/qwen3/)).toBeInTheDocument();

    rerender(<ChatStream conversation={conversation} streaming={{ turnId: "turn-a-1", text: "Partial **markdown** reply" }} disabled route={undefined} onRetry={() => {}} repositoryRoot="C:\HIVE" onOpenArtifacts={() => {}} />);
    expect(screen.queryByLabelText(/hive is thinking/i)).not.toBeInTheDocument();
    expect(screen.getByText("markdown").tagName).toBe("STRONG");
    expect(document.querySelector(".stream-caret")).toBeInTheDocument();
  });

  it("appends streamed chunks into the in-flight assistant message", () => {
    const { rerender } = render(<ChatStream conversation={conversation} streaming={{ turnId: "turn-a-1", text: "Hel" }} disabled onRetry={() => {}} repositoryRoot="C:\HIVE" onOpenArtifacts={() => {}} />);
    rerender(<ChatStream conversation={conversation} streaming={{ turnId: "turn-a-1", text: "Hello world" }} disabled onRetry={() => {}} repositoryRoot="C:\HIVE" onOpenArtifacts={() => {}} />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("copy and retry actions route through the clipboard and the resend handler", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, writable: true, configurable: true });
    const onRetry = vi.fn();
    render(<ChatStream conversation={conversation} streaming={undefined} disabled={false} onRetry={onRetry} repositoryRoot="C:\HIVE" onOpenArtifacts={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(conversation.messages[1].content);
    });
    expect(await screen.findByText("copied!")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledWith("Write a hello function");
    });
  });
});
