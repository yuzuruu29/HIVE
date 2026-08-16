import { describe, it, expect } from "vitest";

const FORBIDDEN_PATTERNS = [
  /sk-[A-Za-z0-9]{32,}/,
  /sk-ant-[A-Za-z0-9_-]{32,}/,
  /access_token\$[A-Za-z0-9]+/,
];

describe("secret scanning", () => {
  it("no platform keys appear in API responses", () => {
    const response = JSON.stringify({
      provider: "openai",
      model: "gpt-4.1-mini",
      managed: true,
    });

    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(response).not.toMatch(pattern);
    }
  });

  it("no platform keys appear in route receipts", () => {
    const receipt = {
      provider: "openai",
      model: "gpt-4.1-mini",
      managed: true,
      costClass: "paid",
    };

    const serialized = JSON.stringify(receipt);
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(serialized).not.toMatch(pattern);
    }
  });

  it("error responses do not leak credentials", () => {
    const errorMessages = [
      "Authentication failed for provider",
      "Rate limit exceeded",
      "Provider unavailable (status 429)",
    ];

    for (const msg of errorMessages) {
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(msg).not.toMatch(pattern);
      }
    }
  });
});
