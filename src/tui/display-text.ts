/** Plain terminal text is sanitized before the renderer adds its own colors. */
import { graphemes } from "./text.js";
import { cleanTerminalControls, sanitizeTerminalText } from "../security/terminal-text.js";
export { sanitizeTerminalText } from "../security/terminal-text.js";

const ZERO_WIDTH = /[\p{Mark}\p{Default_Ignorable_Code_Point}]/u;
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const EMOJI = /\p{Emoji}/u;
const TAB_SIZE = 4;

function isWide(code: number): boolean {
  return code >= 0x1100 && (
    code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x16fe0 && code <= 0x16fe4) || (code >= 0x17000 && code <= 0x18dff) ||
    (code >= 0x1aff0 && code <= 0x1b2ff) || (code >= 0x1f200 && code <= 0x1f251) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** Ambiguous-width characters use one cell; emoji clusters and East Asian wide text use two. */
function graphemeCells(value: string): number {
  // The composer inserts this marker only after removing controls from the draft.
  if (value === "\u0001") return 1;
  if (EMOJI_PRESENTATION.test(value) || (value.includes("\ufe0f") && EMOJI.test(value)) || value.includes("\u20e3")) return 2;
  let cells = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || ZERO_WIDTH.test(char)) continue;
    cells = Math.max(cells, isWide(code) ? 2 : 1);
  }
  return cells;
}

function expandTabs(text: string): string {
  let result = "";
  let column = 0;
  for (const part of graphemes(text)) {
    if (part === "\t") {
      const spaces = TAB_SIZE - column % TAB_SIZE;
      result += " ".repeat(spaces);
      column += spaces;
    } else {
      result += part;
      column = part === "\n" ? 0 : column + graphemeCells(part);
    }
  }
  return result;
}

/** Width of one rendered line; renderer SGR is ignored and tabs use four-cell stops. */
export function terminalCellWidth(text: string): number {
  let cells = 0;
  for (const part of graphemes(expandTabs(sanitizeTerminalText(text)))) cells += graphemeCells(part);
  return cells;
}

export function truncateTerminalText(text: string, width: number): string {
  const limit = Number.isNaN(width) ? 0 : Math.max(0, Math.floor(width));
  if (limit <= 0) return "";
  let result = "";
  let cells = 0;
  const plain = expandTabs(sanitizeTerminalText(text).replace(/\n/g, " "));
  for (const part of graphemes(plain)) {
    const next = graphemeCells(part);
    if (cells + next > limit) break;
    result += part;
    cells += next;
  }
  return result;
}

/** Keeps both ends of a long path or id: the drive or root and the folder name. */
export function truncateMiddle(text: string, width: number, ellipsis = "…"): string {
  const limit = Math.max(0, Math.floor(width));
  const plain = expandTabs(sanitizeTerminalText(text).replace(/\n/g, " "));
  if (terminalCellWidth(plain) <= limit) return plain;
  const room = limit - terminalCellWidth(ellipsis);
  if (room < 2) return truncateTerminalText(plain, limit);
  const parts = [...graphemes(plain)];
  let head = "", tail = "", cells = 0;
  // Favor the tail: the folder name is the part people scan for.
  for (let index = parts.length - 1; index >= 0 && cells + graphemeCells(parts[index]!) <= Math.ceil(room / 2); index--) { tail = parts[index] + tail; cells += graphemeCells(parts[index]!); }
  for (const part of parts) { if (cells + graphemeCells(part) > room) break; head += part; cells += graphemeCells(part); }
  return head + ellipsis + tail;
}

/** Only call on renderer-owned styled output, after its untrusted fields were sanitized. */
export function fitStyledTerminalText(text: string, width: number): string {
  if (!(width > 0)) return "";
  const safe = cleanTerminalControls(text, true).replace(/\n/g, " ");
  return !safe.includes("\t") && terminalCellWidth(safe) <= width ? safe : truncateTerminalText(safe, width);
}

/** Wrap already-sanitized text without trimming indentation, repeated spaces, or graphemes. */
export function wrapDisplayLine(text: string, width: number, preferWords = false): string[] {
  const limit = Math.max(0, Math.floor(width));
  if (limit <= 0) return [];
  const parts = [...graphemes(expandTabs(text))];
  const rows: string[] = [];
  for (let start = 0; start < parts.length;) {
    let end = start;
    let cells = 0;
    let wordEnd = start;
    while (end < parts.length && cells + graphemeCells(parts[end]) <= limit) {
      cells += graphemeCells(parts[end]);
      if (parts[end] === " " && end > start) wordEnd = end + 1;
      end += 1;
    }
    if (end === start) {
      // A two-cell grapheme cannot fit a one-cell terminal; keep a visible placeholder.
      rows.push("\ufffd");
      start += 1;
      continue;
    }
    if (preferWords && end < parts.length && wordEnd > start) end = wordEnd;
    rows.push(parts.slice(start, end).join(""));
    start = end;
  }
  return rows.length > 0 ? rows : [""];
}
