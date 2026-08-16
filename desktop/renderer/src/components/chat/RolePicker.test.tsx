import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DesktopEvent } from "../../../../../src/desktop/types";
import type { DesktopCommandInput } from "../../bridge";
import { RolePicker } from "./RolePicker";

const now = "2026-08-17T00:00:00.000Z";

function makeSend() {
  return vi.fn(async (command: DesktopCommandInput): Promise<DesktopEvent> => ({ type: "request.completed", timestamp: now, requestId: command.requestId ?? "request-1" }));
}

function renderPicker(overrides: Partial<Parameters<typeof RolePicker>[0]> = {}) {
  const props = {
    role: "auto",
    routes: {},
    send: makeSend(),
    onSelect: vi.fn(),
    ...overrides,
  };
  render(<RolePicker {...props} />);
  return props;
}

describe("RolePicker", () => {
  it("shows the current role and opens a seven-option listbox", async () => {
    const props = renderPicker({ role: "coding", routes: { coding: { providerId: "ollama", model: "qwen3", source: "role-assignment", degraded: false } } });
    const user = userEvent.setup();
    expect(screen.getByRole("button", { name: /role: coding/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /role: coding/i }));
    const listbox = screen.getByRole("listbox", { name: /chat roles/i });
    expect(listbox).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(7);
    expect(screen.getByText("ollama/qwen3")).toBeInTheDocument();
    void props;
  });

  it("resolves missing routes on mount and selects a role with arrow keys and Enter", async () => {
    const send = makeSend();
    const onSelect = vi.fn();
    renderPicker({ send, onSelect });
    const roles = send.mock.calls.filter(([{ type }]) => type === "chat.route").map(([command]) => (command as { input?: { role?: string } }).input?.role);
    expect(roles).toEqual(["auto", "planning", "coding", "heavy-reasoning", "game-builder", "project-coworker", "study-buddy"]);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /role: auto/i }));
    const listbox = screen.getByRole("listbox", { name: /chat roles/i });
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("planning");
    expect(listbox).not.toBeInTheDocument();
  });

  it("keeps the current selection marked aria-selected", async () => {
    renderPicker({ role: "study-buddy" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /role: study-buddy/i }));
    const selected = screen.getAllByRole("option").filter((option) => option.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent(/study buddy/i);
  });
});
