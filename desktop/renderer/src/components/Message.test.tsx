import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ThreadMessage } from "../../../../src/desktop/types";
import { Message } from "./Message";

const now = new Date("2026-07-14T10:00:00.000Z").toISOString();

describe("Message component", () => {
  it("renders assistant message with markdown and code blocks", () => {
    const message: ThreadMessage = {
      id: "msg-1",
      role: "assistant",
      content: "# Analysis\nHere is **bold** text and `code`.",
      createdAt: now,
    };

    render(<Message message={message} disabled={false} saving={false} isRetryTarget={false} />);

    expect(screen.getByRole("heading", { level: 1, name: "Analysis" })).toBeInTheDocument();
    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();
    expect(screen.getByText("HIVE")).toBeInTheDocument();
  });

  it("renders user message as plain text without parsing markdown", () => {
    const message: ThreadMessage = {
      id: "msg-2",
      role: "user",
      content: "# Not a heading\n**Not bold**",
      createdAt: now,
    };

    render(<Message message={message} disabled={false} saving={false} isRetryTarget={false} />);

    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByText(/# Not a heading/)).toBeInTheDocument();
    expect(screen.getByText(/\*\*Not bold\*\*/)).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
  });

  it("renders receipt chip when message contains receipt metadata", () => {
    const message: ThreadMessage & { receipt: { role: string; provider: string; model: string; tokens: number; latencyMs: number } } = {
      id: "msg-3",
      role: "assistant",
      content: "Done.",
      createdAt: now,
      receipt: {
        role: "Forger",
        provider: "deepseek",
        model: "deepseek-coder",
        tokens: 1540,
        latencyMs: 850,
      },
    };

    render(<Message message={message} disabled={false} saving={false} isRetryTarget={false} />);

    expect(screen.getByText(/Forger → deepseek\/deepseek-coder · 1,540 tokens · 0.85s/)).toBeInTheDocument();
  });

  it("renders retry button and handles click when isRetryTarget is true", async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    const message: ThreadMessage = {
      id: "msg-4",
      role: "user",
      content: "Try again",
      createdAt: now,
    };

    render(<Message message={message} disabled={false} saving={false} isRetryTarget={true} onRetry={onRetry} />);

    const retryBtn = screen.getByRole("button", { name: /retry run/i });
    const user = userEvent.setup();
    await user.click(retryBtn);

    expect(onRetry).toHaveBeenCalledWith("msg-4");
  });
});
