import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

    expect(runTwo).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
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
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves one option per keypress in a four-command list and runs only once", async () => {
    const commands: PaletteCommand[] = Array.from({ length: 4 }, (_, index) => ({ id: `command-${index}`, label: `Command ${index + 1}`, run: vi.fn() }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<CommandPalette open onClose={onClose} commands={commands} />);
    const input = screen.getByRole("combobox", { name: "Search commands" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
    expect(screen.getByRole("option", { name: "Command 1" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}");
    const second = screen.getByRole("option", { name: "Command 2" });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", second.id);
    await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
    expect(commands[1].run).toHaveBeenCalledTimes(1);
    expect(commands[0].run).not.toHaveBeenCalled();
    expect(commands[2].run).not.toHaveBeenCalled();
    expect(commands[3].run).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("supports first/last navigation, filtering and an empty result without stale execution", async () => {
    const commands: PaletteCommand[] = Array.from({ length: 4 }, (_, index) => ({ id: `command-${index}`, label: `Command ${index + 1}`, run: vi.fn() }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<CommandPalette open onClose={onClose} commands={commands} />);
    const input = screen.getByRole("combobox");
    await user.keyboard("{End}");
    expect(screen.getByRole("option", { name: "Command 4" })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(screen.getByRole("option", { name: "Command 1" })).toHaveAttribute("aria-selected", "true");
    await user.type(input, "missing");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onClose).not.toHaveBeenCalled();
    commands.forEach((command) => expect(command.run).not.toHaveBeenCalled());
    await user.clear(input);
    await user.keyboard("{ArrowUp}{Enter}");
    expect(commands[3].run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("contains keyboard focus and restores the opener after Escape or backdrop dismissal", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><button type="button" onClick={() => setOpen(true)}>Open palette</button><CommandPalette open={open} onClose={() => setOpen(false)} commands={[{ id: "one", label: "First command", run: vi.fn() }]} /></>;
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open palette" });
    await user.click(opener);
    const input = screen.getByRole("combobox");
    await user.tab();
    expect(input).toHaveFocus();
    await user.tab({ shift: true });
    expect(input).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    await user.click(opener);
    const backdrop = screen.getByRole("dialog").parentElement;
    expect(backdrop).not.toBeNull();
    if (backdrop) await user.click(backdrop);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
