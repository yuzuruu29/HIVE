import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModeSwitch } from "./ModeSwitch";
import { initialDesktopState, reduceDesktopEvent } from "../state";

const now = "2026-08-17T00:00:00.000Z";
const conversationId = "chat-1789200000000-ab12";

describe("ModeSwitch", () => {
  it("renders a two-cell tablist and reports mode changes", async () => {
    const onModeChange = vi.fn();
    render(<ModeSwitch mode="coder" onModeChange={onModeChange} />);
    const tablist = screen.getByRole("tablist", { name: /workspace mode/i });
    expect(tablist).toBeInTheDocument();
    const chat = screen.getByRole("tab", { name: /chat/i });
    expect(chat).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: /coder/i })).toHaveAttribute("aria-selected", "true");
    await userEvent.setup().click(chat);
    expect(onModeChange).toHaveBeenCalledWith("chat");
  });

  it("mode action flips state and chunk appends only for the active turn", () => {
    let state = initialDesktopState();
    expect(state.mode).toBe("coder");
    state = reduceDesktopEvent(state, { type: "ui.mode", mode: "chat" });
    expect(state.mode).toBe("chat");

    state = reduceDesktopEvent(state, { type: "chat.started", timestamp: now, conversationId, turnId: "turn-a-1" });
    state = reduceDesktopEvent(state, { type: "chat.chunk", timestamp: now, conversationId, turnId: "turn-a-1", chunk: "Hello ", seq: 0 });
    state = reduceDesktopEvent(state, { type: "chat.chunk", timestamp: now, conversationId, turnId: "turn-stale-9", chunk: "IGNORE", seq: 1 });
    expect(state.chat.streaming[conversationId]).toEqual({ turnId: "turn-a-1", text: "Hello " });

    state = reduceDesktopEvent(state, { type: "chat.completed", timestamp: now, conversationId, turnId: "turn-a-1", message: { id: "msg-1", role: "assistant", content: "Hello HIVE", at: now } });
    expect(state.chat.streaming[conversationId]).toBeUndefined();

    state = reduceDesktopEvent(state, { type: "chat.started", timestamp: now, conversationId, turnId: "turn-b-1" });
    state = reduceDesktopEvent(state, { type: "chat.failed", timestamp: now, conversationId, turnId: "turn-b-1", message: "Cancelled.", recoverable: true });
    expect(state.chat.streaming[conversationId]).toBeUndefined();
    expect(state.error).toBe("Cancelled.");
  });

  it("repository switches reset the chat slice", () => {
    let state = reduceDesktopEvent(initialDesktopState(), { type: "chat.listed", timestamp: now, conversations: [{ id: conversationId, title: "t", role: "auto", updatedAt: now, messageCount: 2 }] });
    state = reduceDesktopEvent(state, { type: "desktop.ready", timestamp: now, repositoryRoot: "C:\\HIVE" });
    expect(state.chat.conversations).toEqual([]);
    expect(state.chat.active).toBeNull();
  });
});
