import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette, PaletteCommand } from "./CommandPalette";

describe("CommandPalette component", () => {
  it("filters commands by substring case-insensitively", async () => {
    const runOne = vi.fn();
    const runTwo = vi.fn();
    const commands: PaletteCommand[] = [
      { id: "cmd-1", label: "Open Repository", hint: "C:\\source", run: runOne },
      { id: "cmd-2", label: "New Thread", hint: "Create task", run: runTwo },
    ];

    render(<CommandPalette open={true} onClose={vi.fn()} commands={commands} />);

    expect(screen.getByText("Open Repository")).toBeInTheDocument();
    expect(screen.getByText("New Thread")).toBeInTheDocument();

    const input = screen.getByPlaceholderText(/Type a command/i);
    const user = userEvent.setup();
    await user.type(input, "repo");

    expect(screen.getByText("Open Repository")).toBeInTheDocument();
    expect(screen.queryByText("New Thread")).not.toBeInTheDocument();
  });

  it("navigates with keyboard and executes with Enter", async () => {
    const runOne = vi.fn();
    const runTwo = vi.fn();
    const onClose = vi.fn();
    const commands: PaletteCommand[] = [
      { id: "cmd-1", label: "First Command", run: runOne },
      { id: "cmd-2", label: "Second Command", run: runTwo },
    ];

    render(<CommandPalette open={true} onClose={onClose} commands={commands} />);
    const input = screen.getByPlaceholderText(/Type a command/i);
    const user = userEvent.setup();

    await user.click(input);
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(runTwo).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape without running any command", async () => {
    const runOne = vi.fn();
    const onClose = vi.fn();
    const commands: PaletteCommand[] = [{ id: "cmd-1", label: "First Command", run: runOne }];

    render(<CommandPalette open={true} onClose={onClose} commands={commands} />);
    const input = screen.getByPlaceholderText(/Type a command/i);
    const user = userEvent.setup();

    await user.click(input);
    await user.keyboard("{Escape}");

    expect(runOne).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
