// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Theme } from "@astryxdesign/core/theme";
import { LinkProvider } from "@astryxdesign/core/Link";
import { hiveTheme } from "@/theme/hive-theme";
import { GeneralSettingsSurface } from "./general-settings-surface";
import { ShareDialog } from "./share-dialog";
import { UsageSurface } from "./usage-surface";
import { BranchNavigator } from "./branch-navigator";
import { ModelPicker } from "./model-picker";
import { CodeBlock } from "./code-block";

let container: HTMLDivElement;
let root: Root;

function TestWrapper({ children }: { children: React.ReactNode }) {
  return (
    <Theme theme={hiveTheme}>
      <LinkProvider component={({ href, children: linkChildren, ...rest }: { href: string; children?: React.ReactNode }) => (
        <a href={href} {...rest}>{linkChildren}</a>
      )}>
        {children}
      </LinkProvider>
    </Theme>
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); this.open = true; };
    HTMLDialogElement.prototype.close = function (returnValue?: string) {
      this.removeAttribute("open");
      this.open = false;
      if (returnValue !== undefined) { this.returnValue = returnValue; }
      this.dispatchEvent(new Event("close", { bubbles: false }));
    };
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn((query: string) => ({ matches: query.includes("min-width: 1200px"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("design remediation interactions", () => {
  it("loads labelled settings and PATCHes bounded values", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { systemPrompt: "Be precise", defaultModel: "model-a", temperature: 0.7 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { systemPrompt: "Be concise", defaultModel: "model-a", temperature: 0.7 } }) });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<TestWrapper><GeneralSettingsSurface /></TestWrapper>));
    await act(async () => undefined);
    const prompt = container.querySelector("textarea")!;
    expect(prompt).toBeTruthy();
    expect(container.querySelector("label")).toBeTruthy();
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(prompt, "Be concise"); prompt.dispatchEvent(new Event("input", { bubbles: true }) as Event); });
    await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/cloud/settings", expect.objectContaining({ method: "PATCH" }));
    expect(JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string).systemPrompt).toBe("Be concise");
  });

  it("opens Share with accessible name, closes on Escape, and verifies dialog structure", async () => {
    const opener = document.createElement("button"); opener.textContent = "Open"; document.body.appendChild(opener); opener.focus();
    const onClose = vi.fn();
    await act(async () => root.render(<TestWrapper><ShareDialog open={true} conversationId="c1" conversationTitle="Title" onClose={onClose} /></TestWrapper>));
    const dialog = document.querySelector('[data-testid="share-dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.tagName).toBe("DIALOG");
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
    expect(document.body.textContent).toContain("Share conversation");
    await act(async () => {
      dialog!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
    opener.remove();
    root = createRoot(container);
  });

  it("creates share on button click, renders URL input and copy/revoke controls", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ data: { token: "tok", url: "/shared/tok" } }) });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<TestWrapper><ShareDialog open={true} conversationId="c1" conversationTitle="Title" onClose={vi.fn()} /></TestWrapper>));
    const createBtn = document.querySelector('[data-testid="share-create-button"]') as HTMLButtonElement;
    expect(createBtn).toBeTruthy();
    expect(createBtn.disabled).toBe(false);
    await act(async () => createBtn.click());
    expect(fetchMock).toHaveBeenCalledWith("/api/cloud/conversations/c1/share", expect.objectContaining({ method: "POST" }));
    await act(async () => undefined);
    const urlInput = document.querySelector('[data-testid="share-url-input"]') as HTMLInputElement;
    expect(urlInput).toBeTruthy();
    expect(urlInput.readOnly).toBe(true);
    expect(urlInput.value).toContain("/shared/tok");
    expect(document.querySelector('[data-testid="share-copy-button"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="share-revoke-button"]')).toBeTruthy();
  });

  it("displays error when share creation fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<TestWrapper><ShareDialog open={true} conversationId="c1" conversationTitle="Title" onClose={vi.fn()} /></TestWrapper>));
    const createBtn = document.querySelector('[data-testid="share-create-button"]') as HTMLButtonElement;
    await act(async () => createBtn.click());
    await act(async () => undefined);
    const errorEl = document.querySelector('[data-testid="share-error"]');
    expect(errorEl).toBeTruthy();
    expect(errorEl!.getAttribute("role")).toBe("alert");
    expect(errorEl!.textContent).toBe("Failed to create share link.");
  });

  it("announces copy success and failure via live region", async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ data: { token: "cp", url: "/shared/cp" } }) });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<TestWrapper><ShareDialog open={true} conversationId="c1" conversationTitle="Title" onClose={vi.fn()} /></TestWrapper>));
    await act(async () => (document.querySelector('[data-testid="share-create-button"]') as HTMLButtonElement).click());
    await act(async () => undefined);
    const copyBtn = document.querySelector('[data-testid="share-copy-button"]') as HTMLButtonElement;
    await act(async () => copyBtn.click());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/shared/cp"));
    await act(async () => copyBtn.click());
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Share link could not be copied");
  });

  it("revokes share link and returns to create state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { token: "rv", url: "/shared/rv" } }) })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<TestWrapper><ShareDialog open={true} conversationId="c1" conversationTitle="Title" onClose={vi.fn()} /></TestWrapper>));
    await act(async () => (document.querySelector('[data-testid="share-create-button"]') as HTMLButtonElement).click());
    await act(async () => undefined);
    expect(document.querySelector('[data-testid="share-url-input"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="share-revoke-button"]')).toBeTruthy();
    await act(async () => (document.querySelector('[data-testid="share-revoke-button"]') as HTMLButtonElement).click());
    await act(async () => undefined);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/cloud/conversations/c1/share", expect.objectContaining({ method: "DELETE" }));
    expect(document.querySelector('[data-testid="share-create-button"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="share-url-input"]')).toBeNull();
  });

  it("displays error when share revocation fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { token: "rf", url: "/shared/rf" } }) })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<TestWrapper><ShareDialog open={true} conversationId="c1" conversationTitle="Title" onClose={vi.fn()} /></TestWrapper>));
    await act(async () => (document.querySelector('[data-testid="share-create-button"]') as HTMLButtonElement).click());
    await act(async () => undefined);
    await act(async () => (document.querySelector('[data-testid="share-revoke-button"]') as HTMLButtonElement).click());
    await act(async () => undefined);
    const errorEl = document.querySelector('[data-testid="share-error"]');
    expect(errorEl).toBeTruthy();
    expect(errorEl!.textContent).toBe("Failed to revoke share link.");
  });

  it("renders all five Usage metrics with the same structural cells as loading", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { managed_credits: 9, requests_per_minute: 20, managed_requests_per_minute: 3, concurrent_streams: 2, web_searches_per_day: 40 } }) }));
    await act(async () => root.render(<TestWrapper><UsageSurface /></TestWrapper>));
    await act(async () => undefined);
    expect(container.querySelectorAll(".usage-metric")).toHaveLength(5);
    expect(container.textContent).toContain("managed requests per minute");
  });

  it("announces branch changes atomically", async () => {
    await act(async () => root.render(<TestWrapper><BranchNavigator current={2} total={3} onPrevious={() => undefined} onNext={() => undefined} /></TestWrapper>));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Version 2 of 3");
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-atomic")).toBe("true");
  });

  it("opens the model-picker portal and closes it with the shared Escape path", async () => {
    await act(async () => root.render(<TestWrapper><ModelPicker models={[]} selectedId="hive-0.1" onChange={() => undefined} /></TestWrapper>));
    await act(async () => container.querySelector<HTMLButtonElement>(".model-picker-trigger")!.click());
    expect(document.body.textContent).toContain("Choose a model");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.body.textContent).not.toContain("Choose a model");
  });

  it("does not return a Promise from the active-option scrolling effect", async () => {
    const scrollIntoView = vi.fn(() => Promise.resolve());
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const models = [{
      id: "groq/llama-test",
      object: "model" as const,
      created: 0,
      owned_by: "groq",
      provider: "groq",
      model: "llama-test",
      displayName: "Llama Test",
      costClass: "free" as const,
      managed: false,
      free: true,
      vision: false,
      tools: true,
    }];

    await act(async () => root.render(<TestWrapper><ModelPicker models={models} selectedId="hive-0.1" onChange={() => undefined} /></TestWrapper>));
    const trigger = container.querySelector<HTMLButtonElement>(".model-picker-trigger")!;
    await act(async () => trigger.click());
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));

    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("announces clipboard success and failure without a legacy fallback", async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await act(async () => root.render(<TestWrapper><CodeBlock language="ts"><code>const value = 1</code></CodeBlock></TestWrapper>));
    const button = container.querySelector<HTMLButtonElement>(".code-block-copy")!;
    await act(async () => button.click());
    expect(container.textContent).toContain("Code copied to clipboard");
    await act(async () => button.click());
    expect(container.textContent).toContain("Code could not be copied");
  });
});
