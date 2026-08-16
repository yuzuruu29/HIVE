import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");

describe("authenticated HIVE typography", () => {
  it("loads and exposes the HIVE pixel display face", () => {
    expect(layout).toContain('@fontsource/silkscreen/400.css');
    expect(css).toContain('--font-display');
  });

  it("uses the display face for hierarchy instead of body copy", () => {
    expect(css).toMatch(/\.app-root[\s\S]*?:is\([^)]*page-heading h2[^)]*\)\s*\{[^}]*font-family: var\(--font-display\)/);
    expect(css).toMatch(/\.app-root[\s\S]*?:is\([^)]*app-topbar h1[^)]*\)\s*\{[^}]*font-family: var\(--font-display\)/);
  });

  it("keeps labels, controls, and navigation in the readable UI face", () => {
    expect(css).toMatch(/\.app-root[\s\S]*?:is\([^)]*\.field label[^)]*\)\s*\{[^}]*font-family: var\(--font-sans\)/);
    expect(css).toMatch(/\.app-root[\s\S]*?:where\(\.input,\s*\.textarea,\s*\.select\)\s*\{[^}]*font-family: var\(--font-sans\)/);
  });

  it("keeps technical metadata numerically stable", () => {
    expect(css).toMatch(/font-variant-numeric: tabular-nums/);
  });
});
