import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialDesktopState } from "../state";
import { SplitWorkspace } from "./SplitWorkspace";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

function setup(width = 1200, splitRatio = 0.4) {
  let measuredWidth = width;
  let measure = () => {};
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    x: 100, y: 0, left: 100, top: 0, right: 100 + measuredWidth, bottom: 700, width: measuredWidth, height: 700, toJSON: () => ({}),
  }));
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { measure = callback; }
    observe() {}
    disconnect() {}
  });
  const onSplitRatioChange = vi.fn();
  render(<SplitWorkspace state={initialDesktopState()} send={vi.fn()} splitRatio={splitRatio} onSplitRatioChange={onSplitRatioChange} />);
  return {
    separator: screen.getByRole("separator", { name: "Resize Chat and Code Panes" }),
    onSplitRatioChange,
    resize: (nextWidth: number) => { measuredWidth = nextWidth; act(() => measure()); },
  };
}

function pointer(node: HTMLElement, type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(node, event);
}

describe("SplitWorkspace resize", () => {
  it("starts from saved ratio, supports bounded keyboard resizing and saves each completed change", () => {
    const { separator, onSplitRatioChange } = setup(1200, 0.55);
    expect(separator).toHaveAttribute("aria-valuenow", "55");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(separator).toHaveAttribute("aria-valuenow", "53");
    expect(onSplitRatioChange).toHaveBeenLastCalledWith(0.53);
    fireEvent.keyDown(separator, { key: "ArrowRight", shiftKey: true });
    expect(separator).toHaveAttribute("aria-valuenow", "63");
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator).toHaveAttribute("aria-valuenow", "70");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "70");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(separator).toHaveAttribute("aria-valuenow", "30");
    expect(separator).toHaveAttribute("aria-controls");
  });

  it("drags with a pointer, preserves useful pane widths, and persists on release", () => {
    const { separator, onSplitRatioChange } = setup(1000);
    pointer(separator, "pointerdown", 500);
    pointer(separator, "pointermove", 1300);
    expect(separator).toHaveAttribute("aria-valuenow", "68");
    expect(onSplitRatioChange).not.toHaveBeenCalled();
    pointer(separator, "pointerup", 1300);
    expect(onSplitRatioChange).toHaveBeenCalledExactlyOnceWith(1 - 320 / 992);
  });

  it("stacks compact workspaces, disables resizing, and restores the saved proportion when widened", () => {
    const { separator, onSplitRatioChange, resize } = setup(800, 0.6);
    expect(screen.getByTestId("split-workspace")).toHaveAttribute("data-stacked", "true");
    expect(separator).toHaveAttribute("aria-disabled", "true");
    expect(separator).toHaveAttribute("tabindex", "-1");
    for (const id of separator.getAttribute("aria-controls")!.split(" ")) {
      const pane = document.getElementById(id);
      expect(pane?.style.flexGrow).toBe("");
      expect(pane?.style.flexBasis).toBe("");
    }
    fireEvent.keyDown(separator, { key: "Home" });
    pointer(separator, "pointerdown", 500);
    pointer(separator, "pointerup", 700);
    expect(onSplitRatioChange).not.toHaveBeenCalled();
    resize(1200);
    expect(screen.getByTestId("split-workspace")).toHaveAttribute("data-stacked", "false");
    expect(separator).toHaveAttribute("aria-valuenow", "60");
    expect(separator).toHaveAttribute("aria-disabled", "false");
  });
});
