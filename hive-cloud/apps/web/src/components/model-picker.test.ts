import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { ModelPicker } from "./model-picker";
import type { HiveModelCatalogEntry } from "@hive-cloud/contracts";

const mockModels: HiveModelCatalogEntry[] = [
  {
    id: "gemini/gemini-2.5-flash",
    object: "model" as const,
    created: 0,
    owned_by: "gemini",
    provider: "gemini",
    model: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    costClass: "free" as const,
    managed: true,
    free: true,
    vision: true,
    tools: true,
  },
  {
    id: "groq/llama-3.3-70b-versatile",
    object: "model" as const,
    created: 0,
    owned_by: "groq",
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    displayName: "Llama 3.3 70B Versatile",
    costClass: "byok" as const,
    managed: false,
    free: false,
    vision: false,
    tools: true,
  }
];

describe("HIVE model picker component", () => {
  beforeAll(() => {
    global.window = {
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: (query: string) => {
        return {
          matches: false,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        };
      },
    } as any;
  });

  afterAll(() => {
    delete (global as any).window;
  });

  it("renders trigger button with correct label when Auto is selected", () => {
    const markup = renderToStaticMarkup(React.createElement(ModelPicker, {
      models: mockModels,
      selectedId: "hive-0.1",
      onChange: () => {},
    }));

    expect(markup).toContain("HIVE Auto");
    expect(markup).toContain("AUTO");
  });

  it("renders trigger button with correct label when specific model is selected", () => {
    const markup = renderToStaticMarkup(React.createElement(ModelPicker, {
      models: mockModels,
      selectedId: "gemini/gemini-2.5-flash",
      onChange: () => {},
    }));

    expect(markup).toContain("Gemini 2.5 Flash");
    expect(markup).toContain("FREE");
  });

  it("renders trigger button with Unavailable state when ID is missing from catalog", () => {
    const markup = renderToStaticMarkup(React.createElement(ModelPicker, {
      models: mockModels,
      selectedId: "groq/llama-invalid",
      onChange: () => {},
    }));

    expect(markup).toContain("Llama Invalid");
    expect(markup).toContain("UNAVAILABLE");
  });

  it("supports compact trigger styles for smaller viewports via CSS classes", () => {
    const markup = renderToStaticMarkup(React.createElement(ModelPicker, {
      models: mockModels,
      selectedId: "hive-0.1",
      onChange: () => {},
    }));

    expect(markup).toContain("model-picker-trigger");
    expect(markup).toContain("model-picker-trigger-badge");
  });
});
