/**
 * glyphs.ts
 * One table of drawing characters for the cockpit. Layout math measures cells,
 * so a glyph may be wider in the ASCII set (ellipsis, mode, pass) without breaking rows.
 */

export interface Glyphs {
  bullet: string;
  result: string;
  user: string;
  focus: string;
  bar: string;
  dot: string;
  ellipsis: string;
  mode: string;
  box: { tl: string; tr: string; bl: string; br: string; h: string; v: string };
  /** The working line's bee: wings flap between open and folded around the body. */
  bee: { open: readonly [string, string]; folded: readonly [string, string]; body: string; trail: string };
  /** Marks where streamed text is arriving. */
  caret: string;
  /** Recorded check outcomes; the word always follows, so color is never the only signal. */
  pass: string;
  fail: string;
}

export const UNICODE_GLYPHS: Glyphs = {
  bullet: "●",
  result: "⎿",
  user: "›",
  focus: "❯",
  bar: "│",
  dot: "·",
  ellipsis: "…",
  mode: "⏵⏵",
  box: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  bee: { open: ["ʚ", "ɞ"], folded: ["ε", "з"], body: "●", trail: "·" },
  caret: "▍",
  pass: "✓",
  fail: "✗",
};

export const ASCII_GLYPHS: Glyphs = {
  bullet: "*",
  result: "|",
  user: ">",
  focus: ">",
  bar: "|",
  dot: "-",
  ellipsis: "...",
  mode: ">>",
  box: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
  bee: { open: ["{", "}"], folded: ["-", "-"], body: "o", trail: "." },
  caret: "_",
  pass: "ok",
  fail: "x",
};

/**
 * Unicode unless the terminal is known to lack it. Legacy Windows consoles
 * (no Windows Terminal, VS Code, ConEmu or TERM) often miss these glyphs in
 * their default font. HIVE_ASCII=1 or --ascii forces the fallback, which also
 * helps CJK locales that draw ambiguous-width glyphs as two cells.
 */
export function prefersAsciiGlyphs(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const forced = env.HIVE_ASCII;
  if (argv.includes("--ascii") || (forced !== undefined && forced !== "" && forced !== "0" && forced.toLowerCase() !== "false")) return true;
  if ((env.TERM ?? "").toLowerCase() === "dumb") return true;
  if (platform !== "win32") return false;
  return !(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === "ON" || env.TERM);
}

export function glyphsFor(state: { asciiGlyphs?: boolean }): Glyphs {
  return state.asciiGlyphs ? ASCII_GLYPHS : UNICODE_GLYPHS;
}
