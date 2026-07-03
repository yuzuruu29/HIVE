import test from "node:test";
import assert from "node:assert";
import {
  renderHiveBanner,
  renderHiveCompactHeader,
  renderHiveWordmark,
  stripAnsi
} from "../dist/ui/index.js";

test("UI Branding", async (t) => {
  await t.test("full banner contains HIVE", () => {
    const banner = renderHiveBanner({ color: false });
    assert.ok(banner.includes("HIVE"));
    assert.ok(banner.includes("Hyper Intelligence for Verified Engineering"));
  });

  await t.test("compact header contains HIVE", () => {
    const header = renderHiveCompactHeader({ color: false });
    assert.ok(header.includes("HIVE"));
    assert.ok(header.includes("Verified Agentic Coding"));
  });

  await t.test("no-color mode strips ANSI and uses ASCII", () => {
    const colored = renderHiveWordmark("HIVE", { color: true });
    assert.ok(colored.includes("\x1b[38;2;"));
    
    const stripped = stripAnsi(colored);
    assert.strictEqual(stripped, "HIVE");
    assert.ok(!stripped.includes("\x1b["));
  });

  await t.test("output contains no non-ASCII characters", () => {
    const banner = renderHiveBanner({ color: false });
    const header = renderHiveCompactHeader({ color: false });
    
    // Check that every character is in the standard ASCII range (0-127)
    for (let i = 0; i < banner.length; i++) {
      assert.ok(banner.charCodeAt(i) <= 127, `Banner contains non-ASCII character: ${banner[i]}`);
    }
    for (let i = 0; i < header.length; i++) {
      assert.ok(header.charCodeAt(i) <= 127, `Header contains non-ASCII character: ${header[i]}`);
    }
  });

  await t.test("NO_COLOR disables gradient", async () => {
    const originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    
    // Simulate what happens internally when color options aren't overridden
    // But since renderHiveWordmark will check supportsColorOutput internally, 
    // we should just call it directly.
    const { supportsColorOutput } = await import("../dist/ui/terminal.js");
    assert.strictEqual(supportsColorOutput(), false);
    
    const output = renderHiveWordmark("HIVE");
    assert.strictEqual(output, "HIVE");
    assert.ok(!output.includes("\x1b["));
    
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
  });

  await t.test("output remains readable without ANSI", () => {
    const banner = stripAnsi(renderHiveBanner({ color: true }));
    assert.ok(banner.includes("HIVE"));
    assert.ok(banner.includes("Hyper Intelligence for Verified Engineering"));
    
    const header = stripAnsi(renderHiveCompactHeader({ color: true }));
    assert.ok(header.includes("HIVE"));
    assert.ok(header.includes("Verified Agentic Coding"));
  });
});
