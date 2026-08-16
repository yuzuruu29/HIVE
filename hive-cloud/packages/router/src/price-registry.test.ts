import { describe, it, expect, beforeEach } from "vitest";
import { PriceRegistry } from "./price-registry.js";

describe("PriceRegistry", () => {
  let registry: PriceRegistry;

  beforeEach(() => {
    registry = new PriceRegistry();
  });

  it("returns a price snapshot for a known model", () => {
    registry.loadSnapshot({
      id: "price-1",
      provider: "openai",
      model: "gpt-4.1-mini",
      inputMicrousdPerMillionTokens: 1_000_000,
      outputMicrousdPerMillionTokens: 4_000_000,
      sourceUrl: "https://developers.openai.com/api/docs/models",
    });

    const price = registry.getPrice("openai", "gpt-4.1-mini");
    expect(price).toBeDefined();
    expect(price!.inputMicrousdPerMillionTokens).toBe(1_000_000);
    expect(price!.outputMicrousdPerMillionTokens).toBe(4_000_000);
  });

  it("returns undefined for unknown model", () => {
    expect(registry.getPrice("openai", "nonexistent")).toBeUndefined();
  });

  it("computes estimated cost correctly", () => {
    registry.loadSnapshot({
      id: "price-1",
      provider: "openai",
      model: "gpt-4.1-mini",
      inputMicrousdPerMillionTokens: 1_000_000,
      outputMicrousdPerMillionTokens: 4_000_000,
      sourceUrl: "https://developers.openai.com/api/docs/models",
    });

    const estimate = registry.estimateCost("openai", "gpt-4.1-mini", 1000, 500);
    expect(estimate.estimatedProviderCostMicrousd).toBe(3_000);
    expect(estimate.estimatedCredits).toBe(1);
  });

  it("fails closed for stale prices", () => {
    registry.loadSnapshot({
      id: "price-1",
      provider: "openai",
      model: "gpt-4.1-mini",
      inputMicrousdPerMillionTokens: 1_000_000,
      outputMicrousdPerMillionTokens: 4_000_000,
      sourceUrl: "https://developers.openai.com/api/docs/models",
      effectiveFrom: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    });

    expect(registry.isStale("openai", "gpt-4.1-mini", 15)).toBe(true);
  });

  it("fresh prices are not stale", () => {
    registry.loadSnapshot({
      id: "price-1",
      provider: "openai",
      model: "gpt-4.1-mini",
      inputMicrousdPerMillionTokens: 1_000_000,
      outputMicrousdPerMillionTokens: 4_000_000,
      sourceUrl: "https://developers.openai.com/api/docs/models",
      effectiveFrom: new Date().toISOString(),
    });

    expect(registry.isStale("openai", "gpt-4.1-mini", 15)).toBe(false);
  });

  it("settleCost computes actual credits from provider usage", () => {
    registry.loadSnapshot({
      id: "price-1",
      provider: "openai",
      model: "gpt-4.1-mini",
      inputMicrousdPerMillionTokens: 1_000_000,
      outputMicrousdPerMillionTokens: 4_000_000,
      sourceUrl: "https://developers.openai.com/api/docs/models",
    });

    const result = registry.settleCost("openai", "gpt-4.1-mini", 1000, 500, 0, 0);
    expect(result.providerCostMicrousd).toBe(3_000);
    expect(result.debitedCredits).toBe(1);
  });

  it("throws for unknown model in estimateCost", () => {
    expect(() => registry.estimateCost("openai", "unknown", 100, 50)).toThrow();
  });
});
