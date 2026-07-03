import test from "node:test";
import assert from "node:assert";
import {
  renderStartupFrame,
  renderCompactStartupFrame,
  renderPlainStartupText,
  renderHelpFrame,
  renderHiveWordmark,
  stripAnsi
} from "../dist/ui/index.js";

test("UI Branding", async (t) => {
  await t.test("full startup frame contains queen bee and HIVE", () => {
    const frame = renderStartupFrame(100, false);
    assert.ok(frame.includes("HIVE"));
    assert.ok(frame.includes("HYPER INTELLIGENCE FOR VERIFIED ENGINEERING"));
    assert.ok(frame.includes("/\\_/\\")); // queen bee ears
  });

  await t.test("compact startup frame contains queen bee and banner", () => {
    const frame = renderCompactStartupFrame(70, false);
    assert.ok(frame.includes("HIVE - Verified Agentic Coding"));
    assert.ok(frame.includes("/\\_/\\")); // compact queen bee ears
  });
  
  await t.test("plain startup text contains banner", () => {
    const text = renderPlainStartupText(false);
    assert.ok(text.includes("HIVE - Verified Agentic Coding"));
    assert.ok(text.includes("hive run"));
  });

  await t.test("no-color mode strips ANSI and uses ASCII", () => {
    const colored = renderHiveWordmark("HIVE", { color: true });
    assert.ok(colored.includes("\x1b[38;2;"));
    
    const stripped = stripAnsi(colored);
    assert.strictEqual(stripped, "HIVE");
    assert.ok(!stripped.includes("\x1b["));
  });

  await t.test("output contains no non-ASCII characters", () => {
    const frame = renderStartupFrame(100, false);
    const compact = renderCompactStartupFrame(70, false);
    const plain = renderPlainStartupText(false);
    
    // Check that every character is in the standard ASCII range (0-127)
    for (let i = 0; i < frame.length; i++) {
      assert.ok(frame.charCodeAt(i) <= 127, `Full frame contains non-ASCII character: ${frame[i]} at index ${i}`);
    }
    for (let i = 0; i < compact.length; i++) {
      assert.ok(compact.charCodeAt(i) <= 127, `Compact frame contains non-ASCII character: ${compact[i]} at index ${i}`);
    }
    for (let i = 0; i < plain.length; i++) {
      assert.ok(plain.charCodeAt(i) <= 127, `Plain text contains non-ASCII character: ${plain[i]} at index ${i}`);
    }
  });

  await t.test("NO_COLOR disables gradient", async () => {
    const originalNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    
    const { supportsColorOutput } = await import("../dist/ui/terminal.js");
    assert.strictEqual(supportsColorOutput(), false);
    
    // Test the fallback
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
    const frame = stripAnsi(renderStartupFrame(100, true));
    assert.ok(frame.includes("HIVE"));
    assert.ok(frame.includes("HYPER INTELLIGENCE FOR VERIFIED ENGINEERING"));
    
    const compact = stripAnsi(renderCompactStartupFrame(70, true));
    assert.ok(compact.includes("HIVE"));
    assert.ok(compact.includes("Verified"));
  });
});
