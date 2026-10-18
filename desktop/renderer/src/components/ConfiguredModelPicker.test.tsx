import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfiguredModelPicker, type ConfiguredModelOption } from "./ConfiguredModelPicker";

const options: ConfiguredModelOption[] = [
  { providerId: "local", providerName: "Local models", model: "qwen-coder" },
  { providerId: "local", providerName: "Local models", model: "llama" },
  { providerId: "remote", providerName: "Remote models", model: "reasoning-large" },
  { providerId: "remote", providerName: "Remote models", model: "fast-small" },
];

describe("ConfiguredModelPicker", () => {
  it("focuses the selected model, navigates one step at a time and selects exactly once", async () => {
    const user = userEvent.setup();
    const onSelectModel = vi.fn();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(<form onSubmit={onSubmit}><ConfiguredModelPicker options={options} selectedModel={options[1]} onSelectModel={onSelectModel} /></form>);
    const trigger = screen.getByRole("button", { name: "Select model" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const list = screen.getByRole("listbox", { name: "Configured models" });
    expect(list).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", list.id);
    expect(list).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "llama" }).id);
    await user.keyboard("{ArrowDown}");
    expect(list).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "reasoning-large" }).id);
    await user.keyboard("{End}");
    expect(list).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "fast-small" }).id);
    await user.keyboard("{Home}{ArrowDown}{Enter}");
    expect(onSelectModel).toHaveBeenCalledExactlyOnceWith(options[1]);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("opens at the last model with ArrowUp and Escape returns focus without changing the route", async () => {
    const user = userEvent.setup();
    const onSelectModel = vi.fn();
    render(<ConfiguredModelPicker options={options} onSelectModel={onSelectModel} />);
    const trigger = screen.getByRole("button", { name: "Select model" });
    trigger.focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "fast-small" }).id);
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onSelectModel).not.toHaveBeenCalled();
    await user.keyboard("{ArrowDown}");
    await user.tab({ shift: true });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps keyboard order aligned with the displayed provider groups", async () => {
    const user = userEvent.setup();
    const onSelectModel = vi.fn();
    render(<ConfiguredModelPicker options={[options[0], options[2], options[1], options[3]]} onSelectModel={onSelectModel} />);
    await user.click(screen.getByRole("button", { name: "Select model" }));
    expect(screen.getAllByRole("group").map((group) => group.getAttribute("aria-labelledby"))).toHaveLength(2);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["qwen-coder", "llama", "reasoning-large", "fast-small"]);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelectModel).toHaveBeenCalledExactlyOnceWith(options[1]);
  });

  it("dismisses outside the popup and lets keyboard users reach provider settings", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(<><ConfiguredModelPicker options={options} onOpenSettings={onOpenSettings} /><button type="button">Outside control</button></>);
    const trigger = screen.getByRole("button", { name: "Select model" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Outside control" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outside control" })).toHaveFocus();
    await user.click(trigger);
    expect(screen.getAllByRole("option")).toHaveLength(options.length);
    await user.tab();
    expect(screen.getByRole("button", { name: "Configure providers" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes when tabbing away or changing context, and opens setup for an empty catalog", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    const onOpenModelPicker = vi.fn();
    const { rerender } = render(<><ConfiguredModelPicker options={options} resetKey="first" /><button type="button" disabled>Unavailable control</button><div style={{ display: "none" }}><button type="button">Hidden control</button></div><button type="button">Next control</button></>);
    await user.click(screen.getByRole("button", { name: "Select model" }));
    await user.tab();
    expect(screen.getByRole("button", { name: "Next control" })).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Select model" }));
    rerender(<ConfiguredModelPicker options={options} resetKey="second" />);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    rerender(<ConfiguredModelPicker options={[]} selectedModel={options[0]} showSavedRoute onOpenModelPicker={onOpenModelPicker} onOpenSettings={onOpenSettings} />);
    const trigger = screen.getByRole("button", { name: "Select model" });
    expect(trigger).toHaveTextContent(options[0].model);
    expect(trigger).toHaveAttribute("title", `${options[0].providerId} / ${options[0].model} (saved session route)`);
    await user.click(trigger);
    expect(onOpenModelPicker).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("portals outside clipped containers and clamps the popup above or below the trigger", async () => {
    const user = userEvent.setup();
    const onSelectModel = vi.fn();
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 240 });
    try {
      const { container } = render(<div style={{ overflow: "clip", width: 100 }}><ConfiguredModelPicker options={options} onSelectModel={onSelectModel} /></div>);
      const trigger = screen.getByRole("button", { name: "Select model" });
      const bounds = vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({ x: 270, y: 200, left: 270, top: 200, right: 310, bottom: 230, width: 40, height: 30, toJSON() {} });
      await user.click(trigger);
      const list = screen.getByRole("listbox");
      const popup = list.parentElement;
      expect(container).not.toContainElement(list);
      expect(popup?.parentElement).toBe(document.body);
      expect(popup).toHaveStyle({ position: "fixed", left: "12px", top: "8px", width: "300px", maxHeight: "184px" });
      expect(list).toHaveFocus();
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 250 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
      bounds.mockReturnValue({ x: 180, y: 16, left: 180, top: 16, right: 220, bottom: 46, width: 40, height: 30, toJSON() {} });
      fireEvent.resize(window);
      expect(popup).toHaveStyle({ left: "8px", top: "54px", width: "234px", maxHeight: "340px" });
      await user.click(screen.getByRole("option", { name: "reasoning-large" }));
      expect(onSelectModel).toHaveBeenCalledExactlyOnceWith(options[2]);
      expect(trigger).toHaveFocus();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
    }
  });

  it("keeps portal footer focus inside the popup and resumes the composer tab order on exit", async () => {
    const user = userEvent.setup();
    render(<><ConfiguredModelPicker options={options} onOpenSettings={vi.fn()} /><button type="button">Next composer control</button></>);
    const trigger = screen.getByRole("button", { name: "Select model" });
    await user.click(trigger);
    await user.tab();
    expect(screen.getByRole("button", { name: "Configure providers" })).toHaveFocus();
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.tab({ shift: true });
    expect(screen.getByRole("listbox")).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Next composer control" })).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });

  it("waits for the positioned popup to be visible before focusing, without stealing footer focus on resize", async () => {
    const user = userEvent.setup();
    const originalFocus = HTMLElement.prototype.focus;
    const listFocusVisibility: string[] = [];
    const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      if (this.getAttribute("role") === "listbox") {
        const visibility = window.getComputedStyle(this).visibility;
        listFocusVisibility.push(visibility);
        // Chromium rejects focus on hidden nodes; jsdom otherwise accepts it.
        if (visibility === "hidden") return;
      }
      originalFocus.call(this, options);
    });
    try {
      render(<ConfiguredModelPicker options={options} onOpenSettings={vi.fn()} />);
      const trigger = screen.getByRole("button", { name: "Select model" });
      trigger.focus();
      await user.keyboard("{ArrowDown}");
      expect(screen.getByRole("listbox")).toHaveFocus();
      expect(listFocusVisibility).toEqual(["visible"]);
      await user.tab();
      const settings = screen.getByRole("button", { name: "Configure providers" });
      expect(settings).toHaveFocus();
      fireEvent.resize(window);
      expect(settings).toHaveFocus();
      expect(listFocusVisibility).toEqual(["visible"]);
    } finally {
      focus.mockRestore();
    }
  });
});
