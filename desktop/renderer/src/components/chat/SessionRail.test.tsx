import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DesktopChatSummary } from "../../../../../src/desktop/types";
import { SessionRail } from "./SessionRail";

const now = "2026-08-17T00:00:00.000Z";
const conversations: DesktopChatSummary[] = [
  { id: "chat-1789200000000-ab12", title: "Plan the migration", role: "planning", updatedAt: now, messageCount: 4 },
  { id: "chat-1789200000100-cd34", title: "Debug rendering loop", role: "coding", updatedAt: now, messageCount: 2 },
  { id: "chat-1789200000200-ef56", title: "Old notes", role: "studyBuddy", updatedAt: now, messageCount: 8, archived: true },
];

describe("SessionRail", () => {
  it("lists active conversations, marks the current one, and groups archived", () => {
    const onLoad = vi.fn();
    render(<SessionRail conversations={conversations} activeId="chat-1789200000100-cd34" onLoad={onLoad} onCreate={() => {}} onArchive={() => {}} />);
    expect(screen.getByRole("button", { name: /plan the migration/i })).toBeInTheDocument();
    const current = screen.getByRole("button", { name: /debug rendering loop/i });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(screen.getByText(/archived \[1\]/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /old notes/i })).not.toBeInTheDocument();
    expect(screen.getByText("Old notes")).toBeInTheDocument();
  });

  it("filters by substring case-insensitively across title and role", async () => {
    const user = userEvent.setup();
    render(<SessionRail conversations={conversations} activeId={null} onLoad={() => {}} onCreate={() => {}} onArchive={() => {}} />);
    await user.type(screen.getByLabelText(/filter conversations/i), "PLAN");
    expect(screen.getByRole("button", { name: /plan the migration/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /debug rendering loop/i })).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText(/filter conversations/i));
    await user.type(screen.getByLabelText(/filter conversations/i), "coding");
    expect(screen.getByRole("button", { name: /debug rendering loop/i })).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/filter conversations/i));
    await user.type(screen.getByLabelText(/filter conversations/i), "nomatch");
    expect(screen.getByText(/no conversations/i)).toBeInTheDocument();
  });

  it("creates and loads conversations through the callbacks", async () => {
    const onLoad = vi.fn();
    const onCreate = vi.fn();
    const user = userEvent.setup();
    render(<SessionRail conversations={conversations} activeId={null} onLoad={onLoad} onCreate={onCreate} onArchive={() => {}} />);
    await user.click(screen.getByRole("button", { name: /new chat/i }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: /plan the migration/i }));
    expect(onLoad).toHaveBeenCalledWith("chat-1789200000000-ab12");
  });
});
