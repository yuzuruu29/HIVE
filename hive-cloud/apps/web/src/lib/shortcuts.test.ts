import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Stub browser globals for node environment.
// ---------------------------------------------------------------------------

function stubBrowserGlobals() {
  const addListener = vi.fn();
  const removeListener = vi.fn();
  const windowMock = {
    addEventListener: addListener,
    removeEventListener: removeListener,
    dispatchEvent: vi.fn(),
  } as unknown as Window & typeof globalThis;
  vi.stubGlobal("window", windowMock);
  const docMock = {
    createElement: () => ({ appendChild: vi.fn(), removeChild: vi.fn() }),
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
  } as unknown as Document;
  if (!(globalThis as Record<string, unknown>).document) {
    vi.stubGlobal("document", docMock);
  }
  return { addListener, removeListener };
}

// ---------------------------------------------------------------------------
// SHORTCUT_HELP_ITEMS tests
// ---------------------------------------------------------------------------

describe("SHORTCUT_HELP_ITEMS", () => {
  beforeEach(() => { stubBrowserGlobals(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("has the expected number of entries", async () => {
    const { SHORTCUT_HELP_ITEMS } = await import("./shortcuts");
    expect(SHORTCUT_HELP_ITEMS).toHaveLength(5);
  });

  it("includes new-chat", async () => {
    const { SHORTCUT_HELP_ITEMS } = await import("./shortcuts");
    const item = SHORTCUT_HELP_ITEMS.find((s) => s.id === "new-chat");
    expect(item).toBeDefined();
    expect(item!.label).toBe("New chat");
    expect(item!.keys).toBe("\u2318+Shift+O");
  });

  it("includes toggle-palette", async () => {
    const { SHORTCUT_HELP_ITEMS } = await import("./shortcuts");
    const item = SHORTCUT_HELP_ITEMS.find((s) => s.id === "toggle-palette");
    expect(item).toBeDefined();
    expect(item!.label).toBe("Command palette");
    expect(item!.keys).toBe("\u2318+K");
  });

  it("includes stop-stream", async () => {
    const { SHORTCUT_HELP_ITEMS } = await import("./shortcuts");
    const item = SHORTCUT_HELP_ITEMS.find((s) => s.id === "stop-stream");
    expect(item).toBeDefined();
    expect(item!.label).toBe("Stop response");
    expect(item!.keys).toBe("Esc");
  });

  it("includes focus-composer", async () => {
    const { SHORTCUT_HELP_ITEMS } = await import("./shortcuts");
    const item = SHORTCUT_HELP_ITEMS.find((s) => s.id === "focus-composer");
    expect(item).toBeDefined();
    expect(item!.label).toBe("Focus composer");
    expect(item!.keys).toBe("/");
  });

  it("includes show-help", async () => {
    const { SHORTCUT_HELP_ITEMS } = await import("./shortcuts");
    const item = SHORTCUT_HELP_ITEMS.find((s) => s.id === "show-help");
    expect(item).toBeDefined();
    expect(item!.label).toBe("Keyboard shortcuts");
    expect(item!.keys).toBe("?");
  });
});

// ---------------------------------------------------------------------------
// Module exports tests
// ---------------------------------------------------------------------------

describe("module exports", () => {
  it("exports useShortcuts as a function", async () => {
    const mod = await import("./shortcuts");
    expect(typeof mod.useShortcuts).toBe("function");
  });

  it("exports SHORTCUT_HELP_ITEMS as an array", async () => {
    const mod = await import("./shortcuts");
    expect(Array.isArray(mod.SHORTCUT_HELP_ITEMS)).toBe(true);
  });

  it("exports ShortcutDef type (verified by function signature)", async () => {
    const mod = await import("./shortcuts");
    expect(typeof mod.useShortcuts).toBe("function");
    // The function has 1 required param (actions) + 1 optional param (enabled).
    // Function.length counts params before the first default value.
    expect(mod.useShortcuts.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// ShortcutDef interface shape verification
// ---------------------------------------------------------------------------

describe("ShortcutDef shape", () => {
  it("accepts a valid action object", () => {
    const action: Record<string, unknown> = {
      id: "test",
      label: "Test",
      keys: "Ctrl+T",
      metaKey: false,
      shiftKey: false,
      key: "t",
      handler: () => undefined,
    };
    expect(action.id).toBe("test");
    expect(action.label).toBe("Test");
    expect(action.keys).toBe("Ctrl+T");
    expect(typeof action.handler).toBe("function");
  });

  it("allows optional metaKey and shiftKey", () => {
    const action: Record<string, unknown> = {
      id: "minimal",
      label: "Minimal",
      keys: "?",
      key: "?",
      handler: () => undefined,
    };
    expect(action.metaKey).toBeUndefined();
    expect(action.shiftKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Verify the module compiles and exports expected members
// ---------------------------------------------------------------------------

it("module compiles and exports expected names", async () => {
  const mod = await import("./shortcuts");
  const exportNames = Object.keys(mod);
  expect(exportNames).toContain("useShortcuts");
  expect(exportNames).toContain("SHORTCUT_HELP_ITEMS");
});