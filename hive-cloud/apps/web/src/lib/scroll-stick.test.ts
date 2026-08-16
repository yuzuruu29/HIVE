import { describe, expect, it } from "vitest";
import { shouldStickToBottom, STICK_THRESHOLD_PX } from "./scroll-stick";

describe("shouldStickToBottom", () => {
  it("returns true when scrolled to the very bottom", () => {
    expect(
      shouldStickToBottom({
        scrollTop: 800,
        scrollHeight: 1000,
        clientHeight: 200,
      })
    ).toBe(true);
  });

  it("returns true when within default threshold of the bottom", () => {
    // 1000 - 880 - 200 = -80 (within 120px threshold, but negative means past bottom)
    // Actually: scrollHeight - scrollTop - clientHeight = 1000 - 880 - 200 = -80
    // But let's test a realistic case: user is 100px from bottom
    expect(
      shouldStickToBottom({
        scrollTop: 700,
        scrollHeight: 1000,
        clientHeight: 200,
      })
    ).toBe(true);
    // 1000 - 700 - 200 = 100, which is <= 120
  });

  it("returns true when exactly at the threshold boundary", () => {
    expect(
      shouldStickToBottom({
        scrollTop: 680,
        scrollHeight: 1000,
        clientHeight: 200,
      })
    ).toBe(true);
    // 1000 - 680 - 200 = 120, which is <= 120
  });

  it("returns false when scrolled beyond the threshold", () => {
    expect(
      shouldStickToBottom({
        scrollTop: 500,
        scrollHeight: 1000,
        clientHeight: 200,
      })
    ).toBe(false);
    // 1000 - 500 - 200 = 300, which is > 120
  });

  it("returns true when container is taller than content", () => {
    expect(
      shouldStickToBottom({
        scrollTop: 0,
        scrollHeight: 100,
        clientHeight: 200,
      })
    ).toBe(true);
    // 100 - 0 - 200 = -100, which is <= 120
  });

  it("returns true when scrollTop is 0 and content just fits", () => {
    expect(
      shouldStickToBottom({
        scrollTop: 0,
        scrollHeight: 200,
        clientHeight: 200,
      })
    ).toBe(true);
    // 200 - 0 - 200 = 0, which is <= 120
  });

  it("returns false when user has scrolled significantly upward", () => {
    expect(
      shouldStickToBottom({
        scrollTop: 0,
        scrollHeight: 5000,
        clientHeight: 200,
      })
    ).toBe(false);
    // 5000 - 0 - 200 = 4800, which is > 120
  });

  it("respects a custom threshold", () => {
    const args = { scrollTop: 700, scrollHeight: 1000, clientHeight: 200 };
    // distance from bottom = 1000 - 700 - 200 = 100
    expect(shouldStickToBottom({ ...args, thresholdPx: 50 })).toBe(false);
    expect(shouldStickToBottom({ ...args, thresholdPx: 100 })).toBe(true);
    expect(shouldStickToBottom({ ...args, thresholdPx: 200 })).toBe(true);
  });

  it("uses default threshold when thresholdPx is undefined", () => {
    expect(STICK_THRESHOLD_PX).toBe(120);
    // Exactly 120px from bottom should stick
    expect(
      shouldStickToBottom({
        scrollTop: 680,
        scrollHeight: 1000,
        clientHeight: 200,
      })
    ).toBe(true);
    // 121px from bottom should not stick
    expect(
      shouldStickToBottom({
        scrollTop: 679,
        scrollHeight: 1000,
        clientHeight: 200,
      })
    ).toBe(false);
  });

  it("handles zero threshold (must be exactly at bottom)", () => {
    expect(
      shouldStickToBottom({
        scrollTop: 800,
        scrollHeight: 1000,
        clientHeight: 200,
        thresholdPx: 0,
      })
    ).toBe(true);
    expect(
      shouldStickToBottom({
        scrollTop: 799,
        scrollHeight: 1000,
        clientHeight: 200,
        thresholdPx: 0,
      })
    ).toBe(false);
  });

  it("handles all-zero dimensions", () => {
    expect(
      shouldStickToBottom({
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
      })
    ).toBe(true);
  });
});
