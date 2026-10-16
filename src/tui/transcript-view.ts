/**
 * transcript-view.ts
 * Wrap the session transcript into viewport rows and window it with scrollOffset.
 * scrollOffset is how many visual rows sit below the viewport. Zero stays pinned
 * to the newest row. Growing the transcript while pinned does not move that pin.
 */

import type { ComposerPicker } from "./picker.js";
import { renderSubagentsPanel } from "./subagents.js";
import type { TuiState } from "./state.js";
import { focusedToolCardPosition, parseToolCard, type ToolCard } from "./tool-card.js";
import { sanitizeTerminalText, terminalCellWidth, truncateTerminalText, wrapDisplayLine } from "./display-text.js";
import { graphemeCursor } from "./text.js";
import { glyphsFor, type Glyphs } from "./glyphs.js";

/** Sits in a composer row where the cursor is drawn. */
export const COMPOSER_CURSOR = "\u0001";

const FRAME_WIDTH_CAP = 160;

export function sessionFrameWidth(width: number): number {
  const raw = width > 0 ? width : 40;
  return Math.max(1, Math.min(raw, FRAME_WIDTH_CAP));
}

export function sessionFrameHeight(height: number): number {
  return height > 0 ? height : 24;
}

export function pickerLineCount(picker: ComposerPicker | undefined): number {
  if (!picker) return 0;
  return Math.max(1, picker.items.length);
}

export interface SessionFramePlan {
  height: number;
  statusRows: number;
  subagentRows: number;
  transcriptRows: number;
  pickerRows: number;
  composerRows: number;
}

/**
 * The status bar is one row at the bottom. The composer band (working line,
 * queue line, input box or permission selector) sits above it. Subagent and
 * picker rows, when open, come out of the transcript budget.
 */
export function sessionFramePlan(input: {
  height: number;
  pickerRows: number;
  subagentRows: number;
  /** Whole composer band, including box borders and the working line. */
  composerRows?: number;
}): SessionFramePlan {
  const height = Math.max(1, input.height);
  const statusRows = 1;
  const minimumBand = height >= 8 ? 3 : height >= 4 ? 2 : 1;
  let composerRows = Math.max(minimumBand, input.composerRows ?? minimumBand);
  if (statusRows + composerRows > height) composerRows = Math.max(0, height - statusRows);
  // A wrapped composer stays in the bottom band. The transcript keeps the majority.
  const majority = Math.floor(height / 2) + 1;
  const composerCap = height - statusRows - majority;
  if (composerCap >= minimumBand) composerRows = Math.min(composerRows, composerCap);
  let remaining = height - statusRows - composerRows;
  const subagentRows = Math.min(Math.max(0, input.subagentRows), remaining);
  remaining -= subagentRows;
  const pickerRows = Math.min(Math.max(0, input.pickerRows), remaining);
  remaining -= pickerRows;
  return {
    height,
    statusRows,
    subagentRows,
    pickerRows,
    composerRows,
    transcriptRows: remaining,
  };
}

export function expandedSubagentLines(state: TuiState, width: number): string[] {
  if (!state.subagentsExpanded) return [];
  return renderSubagentsPanel(state, width);
}

export function planSessionFrame(state: TuiState): SessionFramePlan {
  const width = sessionFrameWidth(state.width);
  return sessionFramePlan({
    height: sessionFrameHeight(state.height),
    pickerRows: pickerLineCount(state.picker),
    subagentRows: expandedSubagentLines(state, width).length,
    composerRows: composerBandRows(state, width),
  });
}

export function composerCursor(input: string, cursor: number | undefined): number {
  if (typeof cursor !== "number" || !Number.isFinite(cursor)) return input.length;
  return graphemeCursor(input, Math.max(0, Math.min(input.length, Math.floor(cursor))));
}

export function composerPrompt(permissionPrompt: string | undefined): string {
  if (permissionPrompt) return `  ? ${permissionPrompt} `;
  return "  > ";
}

export interface ComposerLayout {
  rows: string[];
  cursorRow: number;
}

/**
 * Wrap the composer inside the bottom band. Newlines in the draft stay.
 * COMPOSER_CURSOR marks the cursor column and is one cell wide.
 */
export function layoutComposer(
  input: string,
  cursor: number | undefined,
  width: number,
  prompt: string,
): ComposerLayout {
  const point = composerCursor(input, cursor);
  const logical = `${sanitizeTerminalText(input.slice(0, point))}${COMPOSER_CURSOR}${sanitizeTerminalText(input.slice(point))}`.split("\n");
  const rows: string[] = [];
  let cursorRow = 0;
  const safePrompt = fitVisible(prompt, Math.max(0, width - 1));
  const indent = " ".repeat(terminalCellWidth(safePrompt));
  for (let index = 0; index < logical.length; index += 1) {
    const line = logical[index] ?? "";
    const prefix = index === 0 ? safePrompt : indent;
    const room = Math.max(1, width - terminalCellWidth(prefix));
    const wrapped = wrapDisplayLine(line, room);
    const parts = wrapped.length > 0 ? wrapped : [""];
    for (const part of parts) {
      if (part.includes(COMPOSER_CURSOR)) cursorRow = rows.length;
      rows.push(prefix + part);
    }
  }
  if (rows.length === 0) {
    return { rows: [safePrompt + COMPOSER_CURSOR], cursorRow: 0 };
  }
  return { rows, cursorRow };
}

export function visibleComposerRows(layout: ComposerLayout, maxRows: number): string[] {
  const limit = Math.max(1, maxRows);
  if (layout.rows.length <= limit) return layout.rows;
  let start = layout.cursorRow - limit + 1;
  if (start < 0) start = 0;
  if (start + limit > layout.rows.length) start = Math.max(0, layout.rows.length - limit);
  return layout.rows.slice(start, start + limit);
}

/** Box borders and the one-cell padding on each side of the input. */
export const COMPOSER_BOX_INSET = 4;

/** Prompt inside the input box. The MCP modal keeps its own label. */
export function boxPrompt(state: Pick<TuiState, "mcpInput">): string {
  return state.mcpInput ? "MCP > " : "> ";
}

/** Selector rows between the borders: the options plus an echo row once the user types. */
export function selectorBodyRows(state: Pick<TuiState, "input">): number {
  return 2 + ((state.input ?? "").length > 0 ? 1 : 0);
}

/** The working line shows while a turn runs; the queue line while drafts wait. */
export function activityRowCount(state: Pick<TuiState, "taskStatus" | "messageQueue" | "mcpInput">): number {
  const working = state.taskStatus === "running" || state.taskStatus === "verifying" ? 1 : 0;
  const queue = !state.mcpInput && state.messageQueue && state.messageQueue.length > 0 ? 1 : 0;
  return working + queue;
}

export function composerBandRows(
  state: Pick<TuiState, "height" | "input" | "cursor" | "permissionPrompt" | "pendingPermission" | "messageQueue" | "taskStatus" | "mcpInput">,
  width: number,
): number {
  const height = sessionFrameHeight(state.height);
  if (height < 4) return 1;
  if (height < 8) return 2;
  const activity = activityRowCount(state);
  if (state.pendingPermission && !state.mcpInput) return activity + 2 + selectorBodyRows(state);
  const inner = Math.max(1, width - COMPOSER_BOX_INSET);
  const layout = layoutComposer(state.input ?? "", state.cursor, inner, boxPrompt(state));
  return activity + 2 + Math.max(1, layout.rows.length);
}

export function transcriptViewportRows(state: TuiState): number {
  return planSessionFrame(state).transcriptRows;
}

export function fitVisible(text: string, width: number): string {
  return truncateTerminalText(text, width);
}

/**
 * Renderer-neutral styling. transcript-view picks a tone per span; the renderer
 * owns the actual colors. Span text is always sanitized before it lands here.
 * add, del and user carry a background band that the renderer extends to the row's end.
 */
export type Tone =
  | "text" | "muted" | "dim" | "accent" | "user" | "code"
  | "add" | "del" | "hunk" | "warn" | "error" | "ok"
  | "violet" | "lavender" | "pale" | "gold" | "cursor";
export interface Span { text: string; tone: Tone }
export type Row = Span[];

export function plainRow(row: Row): string {
  return row.map((part) => part.text).join("");
}

export function rowWidth(row: Row): number {
  return row.reduce((cells, part) => cells + terminalCellWidth(part.text), 0);
}

/** Truncate span by span so a row never exceeds width. Also sanitizes each span. */
export function fitSpans(row: Row, width: number): Row {
  const out: Row = [];
  let room = Math.max(0, width);
  for (const part of row) {
    if (room <= 0) break;
    const text = fitVisible(part.text, room);
    if (text) out.push({ text, tone: part.tone });
    room -= terminalCellWidth(text);
  }
  return out;
}

/** Pad a row with plain spaces to exactly width cells. */
export function padRow(row: Row, width: number, tone: Tone = "text"): Row {
  const fitted = fitSpans(row, width);
  const gap = width - rowWidth(fitted);
  return gap > 0 ? [...fitted, { text: " ".repeat(gap), tone }] : fitted;
}

function wrapRaw(text: string, width: number): string[] {
  const normalized = sanitizeTerminalText(text);
  const rows: string[] = [];
  const paragraphs = normalized.split("\n");
  for (const paragraph of paragraphs) {
    const wrapped = wrapDisplayLine(paragraph, width);
    rows.push(...(wrapped.length > 0 ? wrapped : [""]));
  }
  return rows.length > 0 ? rows : [""];
}

function renderInlineCode(text: string): string {
  return text.replace(/`([^`]+)`/g, "$1");
}

/** Headings, lists, and inline code. Fenced blocks and raw HTML stay literal. */
function renderMarkdownLine(line: string): Span {
  const heading = /^ {0,3}(#{1,6}) +(\S.*)$/.exec(line);
  if (heading?.[2]) return { text: renderInlineCode(heading[2].trim()), tone: "accent" };
  const list = /^(\s*)- +(\S.*)$/.exec(line);
  if (list) return { text: `${list[1] ?? ""}  - ${renderInlineCode((list[2] ?? "").trim())}`, tone: "text" };
  return { text: renderInlineCode(line), tone: "text" };
}

function proseRows(text: string, width: number, tone?: Tone): Row[] {
  const rows: Row[] = [];
  for (const paragraph of sanitizeTerminalText(text).split("\n")) {
    const line = renderMarkdownLine(paragraph);
    const wrapped = wrapDisplayLine(line.text, width, true);
    for (const part of wrapped.length > 0 ? wrapped : [""]) rows.push([{ text: part, tone: tone ?? line.tone }]);
  }
  return rows.length > 0 ? rows : [[]];
}

/** Unified-diff line tone; undefined for context and non-diff text. */
function diffTone(line: string): Tone | undefined {
  if (/^(\+\+\+|---) /.test(line)) return "dim";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return undefined;
}

export function statusTone(status: string): Tone {
  if (/fail|error|reject|denied|declined/i.test(status)) return "error";
  if (/^(asking|blocked|pending)$/i.test(status)) return "warn";
  if (/^(cancelled|skipped)$/i.test(status)) return "dim";
  if (/^(running|verifying|working)$/i.test(status)) return "accent";
  return "ok";
}

/** A lead column (gutter or label) followed by wrapped text in one tone. */
function guttered(lead: Span, continuation: string, text: string, tone: Tone, width: number): Row[] {
  const room = Math.max(1, width - terminalCellWidth(lead.text));
  return wrapRaw(text, room).map((part, index) =>
    fitSpans([index === 0 ? lead : { text: continuation, tone: lead.tone }, { text: part, tone }], width));
}

/** Line numbers follow the latest hunk header; unknown before one is seen. */
interface DiffCursor { old?: number; next?: number }

const NUMBER_CELLS = 4;

/**
 * One unified-diff line as numbered rows: "  12 + text". Added and removed
 * rows carry a tinted band; file headers and summaries stay dim.
 */
function diffLineRows(line: string, width: number, cursor: DiffCursor): Row[] {
  const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (hunk) {
    cursor.old = Number(hunk[1]);
    cursor.next = Number(hunk[2]);
    return guttered({ text: "", tone: "hunk" }, "", line, "hunk", width);
  }
  const sign = line[0];
  if (/^(\+\+\+|---) /.test(line) || (sign !== "+" && sign !== "-" && sign !== " ")) {
    return guttered({ text: "", tone: "dim" }, "", line, "dim", width);
  }
  let number: number | undefined;
  if (sign === "-") number = cursor.old !== undefined ? cursor.old++ : undefined;
  else if (sign === "+") number = cursor.next !== undefined ? cursor.next++ : undefined;
  else {
    number = cursor.next !== undefined ? cursor.next++ : undefined;
    if (cursor.old !== undefined) cursor.old += 1;
  }
  const label = `${number === undefined ? "" : String(number)}`.padStart(NUMBER_CELLS) + ` ${sign === " " ? " " : sign} `;
  const tone: Tone = sign === "+" ? "add" : sign === "-" ? "del" : "muted";
  return guttered({ text: label, tone }, " ".repeat(label.length), line.slice(1), tone, width);
}

function codeRows(lines: readonly string[], lang: string, width: number, g: Glyphs): Row[] {
  const fence = (text: string): Row => [{ text: fitVisible(text, width), tone: "dim" }];
  const rows: Row[] = [fence(lang ? "```" + lang : "```")];
  const isDiff = lang === "diff" || lang === "patch";
  const bar = `${g.bar} `;
  for (const line of lines) {
    const tone = isDiff ? diffTone(line) ?? "code" : "code";
    rows.push(...(width <= 2 ? [fence(bar + line)] : guttered({ text: bar, tone: "dim" }, bar, line, tone, width)));
  }
  rows.push(fence("```"));
  return rows;
}

const USER_PREFIX = "[User] ";
const ERROR_PREFIX = "[Error] ";

/** "● tool(summary)" with a right-aligned status, then "⎿" results. */
function renderToolCardRows(card: ToolCard, width: number, focused: boolean, g: Glyphs, frame?: number): Row[] {
  const status = fitVisible(card.status, 16);
  const tone = statusTone(card.status);
  const statusSpan: Span = { text: status, tone };
  // A running card's bullet breathes between bright and dim.
  const bulletTone: Tone = tone === "accent" && frame !== undefined && Math.floor(frame / 3) % 2 === 1 ? "dim" : tone;
  const left = fitSpans([
    focused ? { text: `${g.focus} `, tone: "accent" } : { text: `${g.bullet} `, tone: bulletTone },
    { text: card.tool, tone: focused ? "accent" : "text" },
    { text: `(${card.summary})`, tone: "muted" },
  ], Math.max(0, width - terminalCellWidth(status) - 1));
  const gap = width - rowWidth(left) - terminalCellWidth(status);
  const rows: Row[] = [gap >= 1 ? [...left, { text: " ".repeat(gap), tone: "text" }, statusSpan] : fitSpans([...left, statusSpan], width)];
  const first = `  ${g.result}  `;
  const rest = " ".repeat(first.length);
  const indent = (body: Row[]): Row[] => body.map((row, index) => fitSpans([{ text: index === 0 ? first : rest, tone: "dim" }, ...row], width));
  const inner = Math.max(1, width - first.length);
  const body: Row[] = [];
  if (card.expanded && card.body.length > 0) {
    const cursor: DiffCursor = {};
    for (const line of card.body) {
      if (card.kind === "edit") body.push(...diffLineRows(line, inner, cursor));
      else body.push(...wrapRaw(line, inner).map((part): Row => [{ text: part, tone: "muted" }]));
    }
  } else if (card.body.length > 0) {
    body.push([{ text: `${card.body.length} line${card.body.length === 1 ? "" : "s"} ${g.dot} ctrl+o to expand`, tone: "dim" }]);
  }
  if (card.prompt) body.push([{ text: "Awaiting approval", tone: "warn" }]);
  rows.push(...indent(body));
  return rows;
}

/**
 * Message content without its bullet. Prose wraps to the column width; a
 * fenced block keeps its fence and a left bar so code stands apart.
 */
export function renderEntryRows(entry: string, width: number, focused = false, g: Glyphs = glyphsFor({}), frame?: number): Row[] {
  const card = parseToolCard(entry);
  if (card) return renderToolCardRows(card, width, focused, g, frame);
  const normalized = sanitizeTerminalText(entry);
  if (!normalized.includes("```")) return proseRows(normalized, width);

  const rows: Row[] = [];
  let prose: string[] = [];
  let code: string[] | null = null;
  let lang = "";
  const flushProse = (): void => {
    if (prose.length === 0) return;
    rows.push(...proseRows(prose.join("\n"), width));
    prose = [];
  };
  for (const line of normalized.split("\n")) {
    if (code === null) {
      const open = /^\s*```([\w.+-]*)\s*$/.exec(line);
      if (open) {
        flushProse();
        code = [];
        lang = open[1] ?? "";
        continue;
      }
      prose.push(line);
      continue;
    }
    if (/^\s*```\s*$/.test(line)) {
      rows.push(...codeRows(code, lang, width, g));
      code = null;
      lang = "";
      continue;
    }
    code.push(line);
  }
  if (code !== null) rows.push(...codeRows(code, lang, width, g));
  else flushProse();
  return rows.length > 0 ? rows : [[]];
}

export function renderEntry(entry: string, width: number, focused = false): string[] {
  return renderEntryRows(entry, width, focused).map(plainRow);
}

/** Prefix the first row with a marker and indent the rest under its text. */
function marked(marker: Span, rows: Row[], width: number): Row[] {
  const lead = terminalCellWidth(marker.text);
  return rows.map((row, index) => fitSpans([index === 0 ? marker : { text: " ".repeat(lead), tone: "text" }, ...row], width));
}

/** Bee positions along the sky row: it flies left over the hive and back. */
const SKY_PATH = [10, 8, 6, 4, 2, 0, 2, 4, 6, 8];

/**
 * A purple skep hive in ringed bands with an arched door, under a sky row
 * where a gold bee hovers. Every row is 13 cells. At rest the bee sits top
 * right; while a turn runs it flies back and forth over the hive, flapping.
 */
function beeHive(g: Glyphs, frame?: number): Row[] {
  const ascii = g.bullet === "*";
  const at = frame === undefined ? SKY_PATH[0] : SKY_PATH[frame % SKY_PATH.length];
  const wings = frame === undefined || frame % 2 === 0 ? g.bee.open : g.bee.folded;
  const sky: Row = [
    { text: " ".repeat(at), tone: "text" },
    { text: wings[0], tone: "pale" }, { text: g.bee.body, tone: "gold" }, { text: wings[1], tone: "pale" },
    { text: " ".repeat(10 - at), tone: "text" },
  ];
  if (ascii) {
    return [
      sky,
      [{ text: "   .-===-.   ", tone: "lavender" }],
      [{ text: "  (=======)  ", tone: "accent" }],
      [{ text: " (=========) ", tone: "lavender" }],
      [{ text: "(=====", tone: "accent" }, { text: "n", tone: "dim" }, { text: "=====)", tone: "accent" }],
    ];
  }
  return [
    sky,
    [{ text: "   ▄▄███▄▄   ", tone: "lavender" }],
    [{ text: " ▄█████████▄ ", tone: "accent" }],
    [{ text: " ███████████ ", tone: "lavender" }],
    [{ text: "▄████▀ ▀████▄", tone: "accent" }],
  ];
}

const WELCOME_CAP = 78;
const MASCOT_CELLS = 13;

function shown(value: unknown): string {
  return value === undefined || value === null || value === "" ? "none" : String(value);
}

/** Bordered card with the hive mascot, product line, runtime and workspace, then a tips line. */
function welcomeRows(state: TuiState, width: number, g: Glyphs, frame?: number): Row[] {
  const place = [state.workspaceName, state.gitBranch ? `(${state.gitBranch})` : undefined].filter(Boolean).join(" ");
  const text: Row[] = [
    [{ text: "HIVE", tone: "pale" }],
    [{ text: "Hyper Intelligence for Verified Engineering", tone: "muted" }],
    [{ text: `${shown(state.provider)} ${g.dot} ${shown(state.model)} ${g.dot} ${state.sessionMode || "guarded"}`, tone: "text" }],
    [{ text: place || "no workspace", tone: "muted" }],
    [],
  ];
  const tips: Row = [{ text: `  /help for commands ${g.dot} @ for files ${g.dot} shift+tab for modes`, tone: "dim" }];
  if (width < 24) return [[{ text: "HIVE", tone: "pale" }], []];
  const boxWidth = Math.min(width, WELCOME_CAP);
  const inner = boxWidth - 4;
  const withMascot = inner >= MASCOT_CELLS + 2 + 20;
  const mascot = withMascot ? beeHive(g, frame) : [];
  // The fifth text row only exists to sit beside the hive's base.
  const lines = withMascot ? text : text.slice(0, 4);
  const body = lines.map((row, index): Row => padRow(withMascot ? [...mascot[index], { text: "  ", tone: "text" }, ...row] : row, inner));
  const { tl, tr, bl, br, h, v } = g.box;
  return [
    [{ text: tl + h.repeat(boxWidth - 2) + tr, tone: "violet" }],
    ...body.map((row): Row => [{ text: `${v} `, tone: "violet" }, ...row, { text: ` ${v}`, tone: "violet" }]),
    [{ text: bl + h.repeat(boxWidth - 2) + br, tone: "violet" }],
    fitSpans(tips, width),
  ];
}

export function transcriptEntries(state: Pick<TuiState, "transcript" | "outputLines" | "liveText">): string[] {
  const source = state.transcript.length > 0 ? [...state.transcript] : [...state.outputLines];
  const live = state.liveText;
  if (live?.trim() && source[source.length - 1] !== live) source.push(live);
  return source;
}

type EntryKind = "user" | "card" | "error" | "note" | "diff" | "prose";

/**
 * Styled transcript rows under the welcome card. User turns, messages, cards
 * and errors each open with a blank row; indented notes and diff lines attach
 * to the block above. Unified diffs arrive one line per entry, so a "--- " or
 * "diff " entry starts a numbered diff run.
 */
export function renderTranscriptRows(state: TuiState, width = sessionFrameWidth(state.width), frame?: number): Row[] {
  const inner = Math.max(1, width);
  const g = glyphsFor(state);
  const entries = transcriptEntries(state);
  const cards = entries.filter((entry) => parseToolCard(entry)).length;
  const focus = focusedToolCardPosition(cards, state.toolCardFocus);
  const active = state.taskStatus === "running" || state.taskStatus === "verifying";
  const rows: Row[] = welcomeRows(state, inner, g, active ? frame : undefined);
  let seen = 0;
  let previous: EntryKind | undefined;
  let inDiff = false;
  const cursor: DiffCursor = {};
  for (const entry of entries) {
    const isCard = parseToolCard(entry) !== null;
    const singleLine = !isCard && !entry.includes("\n");
    if (singleLine && /^(--- |diff )/.test(entry)) {
      inDiff = true;
      cursor.old = undefined;
      cursor.next = undefined;
    } else if (!(inDiff && singleLine && /^([+\- @\\]|$|\.\.\.\[truncated\])/.test(entry))) inDiff = false;
    const kind: EntryKind = isCard ? "card"
      : inDiff ? "diff"
        : entry.startsWith(USER_PREFIX) ? "user"
          : entry.startsWith(ERROR_PREFIX) ? "error"
            : /^\s/.test(entry) ? "note" : "prose";
    const opensBlock = kind === "user" || kind === "card" || kind === "error" || (kind === "prose" && previous !== "prose");
    if (opensBlock) rows.push([]);
    previous = kind === "note" || kind === "diff" ? previous : kind;
    const body = inner - 2;
    switch (kind) {
      case "diff":
        rows.push(...diffLineRows(entry, Math.max(1, inner - 5), cursor).map((row) => fitSpans([{ text: "     ", tone: "text" }, ...row], inner)));
        break;
      case "note":
        rows.push(...wrapRaw(entry, inner).map((part): Row => [{ text: part, tone: "muted" }]));
        break;
      case "user":
        rows.push(...marked({ text: `${g.user} `, tone: "user" }, wrapRaw(entry.slice(USER_PREFIX.length), body).map((part): Row => [{ text: part, tone: "user" }]), inner));
        break;
      case "error":
        rows.push(...marked({ text: `${g.bullet} `, tone: "error" }, proseRows(`Error: ${entry.slice(ERROR_PREFIX.length)}`, body, "error"), inner));
        break;
      case "card":
        rows.push(...renderEntryRows(entry, inner, seen++ === focus, g, frame));
        break;
      default:
        rows.push(...marked({ text: `${g.bullet} `, tone: "text" }, renderEntryRows(entry, body, false, g), inner));
    }
  }
  // A caret trails text that is still streaming; it blinks with motion. It
  // never adds a row, so scroll math is the same whether it shows or not.
  const streaming = active && Boolean(state.liveText?.trim()) && entries[entries.length - 1] === state.liveText;
  const last = rows[rows.length - 1];
  if (streaming && last && rowWidth(last) < inner && (frame === undefined || Math.floor(frame / 4) % 2 === 0)) {
    rows[rows.length - 1] = [...last, { text: g.caret, tone: "accent" }];
  }
  return rows;
}

export function renderTranscriptBody(state: TuiState, width = sessionFrameWidth(state.width)): string[] {
  return renderTranscriptRows(state, width).map(plainRow);
}

export function clampScrollOffset(offset: number, rowCount: number, viewport: number): number {
  const max = Math.max(0, rowCount - Math.max(0, viewport));
  if (!Number.isFinite(offset) || offset <= 0) return 0;
  return Math.min(max, Math.floor(offset));
}

/**
 * Keep the same rows on screen when content below the viewport grows.
 * A pin at zero stays on the newest row.
 */
export function scrollOffsetAfterGrowth(
  offset: number,
  beforeCount: number,
  afterCount: number,
  viewport: number,
): number {
  if (!Number.isFinite(offset) || offset <= 0) return 0;
  const grew = afterCount - beforeCount;
  const next = grew >= 0 ? offset + grew : Math.max(0, offset + grew);
  return clampScrollOffset(next, afterCount, viewport);
}

export function windowTranscript(rows: readonly string[], viewport: number, scrollOffset: number): string[];
export function windowTranscript<T>(rows: readonly T[], viewport: number, scrollOffset: number, blank: T): T[];
export function windowTranscript<T>(rows: readonly T[], viewport: number, scrollOffset: number, blank: T = "" as T): T[] {
  if (viewport <= 0) return [];
  const offset = clampScrollOffset(scrollOffset, rows.length, viewport);
  const end = rows.length - offset;
  const start = Math.max(0, end - viewport);
  const slice = rows.slice(start, end);
  const pad = viewport - slice.length;
  return [...Array.from({ length: pad }, () => blank), ...slice];
}

export function nextScrollOffset(state: TuiState, direction: 1 | -1, unit: "page" | "wheel"): number {
  const plan = planSessionFrame(state);
  const total = renderTranscriptBody(state).length;
  const step = unit === "wheel" ? 3 : Math.max(1, plan.transcriptRows);
  return clampScrollOffset(state.scrollOffset + direction * step, total, plan.transcriptRows);
}
