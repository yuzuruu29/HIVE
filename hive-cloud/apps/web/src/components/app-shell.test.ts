import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/chat", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: (props: Record<string, unknown>) => React.createElement("a", props, props.children as React.ReactNode),
}));
vi.mock("@/app/signout-action", () => ({
  signOutAction: "signout-action-stub",
}));
vi.mock("@/lib/shortcuts", () => ({
  useShortcuts: () => undefined,
  SHORTCUT_HELP_ITEMS: [
    { id: "new-chat", label: "New chat", keys: "⌘+Shift+O" },
    { id: "toggle-palette", label: "Command palette", keys: "⌘+K" },
    { id: "stop-stream", label: "Stop response", keys: "Esc" },
    { id: "focus-composer", label: "Focus composer", keys: "/" },
    { id: "show-help", label: "Keyboard shortcuts", keys: "?" },
  ],
}));

import { AppShell } from "./app-shell";

function render(children: React.ReactNode = null) {
  return renderToStaticMarkup(
    React.createElement(AppShell, { title: "Test", email: "user@example.com", children }),
  );
}

describe("AppShell account popover", () => {
  it("renders a sign-out form that posts to the sign-out server action", () => {
    const markup = render();

    const form = markup.match(/<form[^>]*>/)?.[0];
    expect(form).toBeDefined();
    expect(form).toContain('action="');
    expect(form).toContain("signout");
  });

  it("renders a sign-out button with an accessible name", () => {
    const markup = render();

    expect(markup).toContain('data-testid="sign-out"');
    expect(markup).toMatch(/aria-label="Sign out"|>Sign out</);
  });
});

describe("AppShell keyboard shortcuts", () => {
  it("renders the command trigger button that opens the navigation menu", () => {
    const markup = render();
    expect(markup).toContain("command-trigger");
    expect(markup).toContain("Navigate");
  });

  it("renders the theme toggle button", () => {
    const markup = render();
    expect(markup).toContain('aria-label="Switch to');
  });

  it("renders the router status indicator", () => {
    const markup = render();
    expect(markup).toContain("Queen online");
    expect(markup).toContain("router-status");
  });
});
