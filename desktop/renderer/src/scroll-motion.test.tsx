import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSurface } from "./components/chat/ChatSurface";
import { CodexSurface } from "./components/codex/CodexSurface";
import { ChangesView } from "./components/ChangesView";
import { initialDesktopState } from "./state";

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

afterEach(() => {
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each([true, false])("scrolling when reduced motion is %s", (reducedMotion) => {
  function observeScroll() {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: reducedMotion }));
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    return scroll;
  }

  it("respects the preference when following chat messages", () => {
    const scroll = observeScroll();
    const state = initialDesktopState();
    const at = new Date().toISOString();
    state.chat.active = { id: "c1", cwd: "C:/repo", role: "auto", ground: false, createdAt: at, updatedAt: at, messages: [{ id: "m1", role: "user", content: "Hi", at }] };
    render(<ChatSurface state={state} send={vi.fn()} />);
    expect(scroll).toHaveBeenCalledWith({ behavior: reducedMotion ? "auto" : "smooth" });
  });

  it("respects the preference when following code messages", () => {
    const scroll = observeScroll();
    render(<CodexSurface state={initialDesktopState()} send={vi.fn()} />);
    expect(scroll).toHaveBeenCalledWith({ behavior: reducedMotion ? "auto" : "smooth" });
  });

  it("respects the preference when navigating a changed file", () => {
    const scroll = observeScroll();
    render(<ChangesView patch={"diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-before\n+after"} />);
    fireEvent.click(screen.getByRole("button", { name: /^file\.ts/ }));
    expect(scroll).toHaveBeenCalledWith({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  });
});
