/**
 * renderer.ts
 * Pure render functions for the HIVE TUI cockpit.
 * Untrusted text is sanitized before renderer-owned ANSI colors are applied.
 */

import { redactKnownSecrets } from "../security/secrets.js";
import { hasProvider, TuiState } from "./state.js";
import { BRAND_COLORS } from "../ui/colors.js";
import { fitStyledTerminalText, sanitizeTerminalText, terminalCellWidth, truncateMiddle, wrapDisplayLine } from "./display-text.js";
import { glyphsFor, type Glyphs } from "./glyphs.js";
import {
  boxPrompt,
  COMPOSER_BOX_INSET,
  COMPOSER_CURSOR,
  expandedSubagentLines,
  fitSpans,
  fitVisible,
  layoutComposer,
  padRow,
  permissionContextRows,
  permissionDisplayPrompt,
  planSessionFrame,
  renderTranscriptRows,
  rowWidth,
  sessionFrameHeight,
  sessionFrameWidth,
  visibleComposerRows,
  windowTranscript,
  type Row,
  type Tone,
} from "./transcript-view.js";

// -- Helpers -------------------------------------------------------------------

function rep(char: string, count: number): string {
  if (count <= 0) return "";
  return char.repeat(count);
}

type Rgb = { r: number; g: number; b: number };

type Palette = Record<Tone, { fg: Rgb; bg?: Rgb; band?: boolean }>;

/**
 * Semantic colors: violet for HIVE, gold for the bee, green and red
 * only for change and outcome. Banded tones paint a background to the row's end.
 */
const DARK: Palette = {
  text: { fg: BRAND_COLORS.text },
  muted: { fg: BRAND_COLORS.muted },
  dim: { fg: BRAND_COLORS.dim },
  accent: { fg: BRAND_COLORS.accent },
  user: { fg: { r: 221, g: 214, b: 254 }, bg: { r: 30, g: 26, b: 51 }, band: true },
  code: { fg: { r: 196, g: 181, b: 253 } },
  add: { fg: { r: 134, g: 239, b: 172 }, bg: { r: 15, g: 46, b: 28 }, band: true },
  del: { fg: { r: 252, g: 165, b: 165 }, bg: { r: 59, g: 18, b: 25 }, band: true },
  hunk: { fg: { r: 103, g: 232, b: 249 } },
  warn: { fg: { r: 245, g: 158, b: 11 } },
  error: { fg: { r: 248, g: 113, b: 113 } },
  ok: { fg: BRAND_COLORS.success },
  violet: { fg: BRAND_COLORS.primary_bright },
  lavender: { fg: { r: 167, g: 139, b: 250 } },
  pale: { fg: { r: 221, g: 214, b: 254 } },
  gold: { fg: { r: 245, g: 197, b: 66 } },
  cursor: { fg: BRAND_COLORS.text, bg: { r: 167, g: 139, b: 250 } },
};

/** Same roles on a light background: deeper inks, pastel bands. "pale" becomes the darkest violet. */
const LIGHT: Palette = {
  text: { fg: { r: 31, g: 41, b: 55 } },
  muted: { fg: { r: 75, g: 85, b: 99 } },
  dim: { fg: { r: 107, g: 114, b: 128 } },
  accent: { fg: { r: 109, g: 40, b: 217 } },
  user: { fg: { r: 76, g: 29, b: 149 }, bg: { r: 237, g: 233, b: 254 }, band: true },
  code: { fg: { r: 109, g: 40, b: 217 } },
  add: { fg: { r: 22, g: 101, b: 52 }, bg: { r: 220, g: 252, b: 231 }, band: true },
  del: { fg: { r: 153, g: 27, b: 27 }, bg: { r: 254, g: 226, b: 226 }, band: true },
  hunk: { fg: { r: 14, g: 116, b: 144 } },
  warn: { fg: { r: 180, g: 83, b: 9 } },
  error: { fg: { r: 220, g: 38, b: 38 } },
  ok: { fg: { r: 21, g: 128, b: 61 } },
  violet: { fg: { r: 109, g: 40, b: 217 } },
  lavender: { fg: { r: 139, g: 92, b: 246 } },
  pale: { fg: { r: 91, g: 33, b: 182 } },
  gold: { fg: { r: 183, g: 121, b: 31 } },
  cursor: { fg: { r: 255, g: 255, b: 255 }, bg: { r: 124, g: 58, b: 237 } },
};

/** No palette means plain text. */
function paletteFor(state: Pick<TuiState, "colorEnabled" | "lightTheme">): Palette | undefined {
  if (!state.colorEnabled) return undefined;
  return state.lightTheme ? LIGHT : DARK;
}

function sgr(text: string, tone: Tone, palette: Palette): string {
  const { fg, bg } = palette[tone];
  const fore = `[38;2;${fg.r};${fg.g};${fg.b}m`;
  const back = bg ? `[48;2;${bg.r};${bg.g};${bg.b}m` : "";
  return `${fore}${back}${text}[0m`;
}

/**
 * Plain text without a palette. With one and a width, a row ending in a
 * banded tone (diff lines, user turns) carries that background to the edge.
 */
function paintRow(row: Row, palette: Palette | undefined, width?: number): string {
  if (!palette) return row.map((part) => part.text).join("");
  const last = row[row.length - 1];
  const painted = row.map(({ text, tone }) => (text ? sgr(text, tone, palette) : "")).join("");
  if (width === undefined || !last || !palette[last.tone].band) return painted;
  const gap = width - row.reduce((cells, part) => cells + terminalCellWidth(part.text), 0);
  return gap > 0 ? painted + sgr(" ".repeat(gap), last.tone, palette) : painted;
}

// -- Picker --------------------------------------------------------------------

/** Suggestions under the input box, Claude Code style. */
export function renderPickerRows(state: TuiState, availableRows = Infinity): string[] {
  const picker = state.picker;
  if (!picker || availableRows <= 0) return [];
  const width = sessionFrameWidth(state.width);
  const g = glyphsFor(state);
  if (picker.items.length === 0) {
    if (picker.loading) return [paintRow([{ text: "  Searching files", tone: "dim" }], paletteFor(state))];
    return [paintRow([{ text: picker.kind === "file" ? "  No matching files" : "  No matching commands", tone: "dim" }], paletteFor(state))];
  }
  const limit = Math.max(0, Math.min(picker.items.length, Math.floor(availableRows)));
  const selectedIndex = Math.max(0, Math.min(picker.items.length - 1, picker.selected));
  const start = Math.min(Math.max(0, selectedIndex - Math.floor(limit / 2)), picker.items.length - limit);
  return picker.items.slice(start, start + limit).map((item, index) => {
    const selected = start + index === selectedIndex;
    return paintRow(fitSpans([
      { text: selected ? `  ${g.focus} ` : "    ", tone: "accent" },
      { text: item.label, tone: selected ? "accent" : "text" },
      { text: item.detail ? `  ${item.detail}` : "", tone: "dim" },
    ], width), paletteFor(state));
  });
}

// -- Transcript ----------------------------------------------------------------

/** Visible transcript rows, colored by tone when color is on. */
export function renderMainPanel(
  state: TuiState,
  availableRows: number,
  now = Date.now(),
): string[] {
  const width = sessionFrameWidth(state.width);
  const rows = renderTranscriptRows(state, width, motionFrame(state, now));
  return windowTranscript<Row>(rows, Math.max(0, availableRows), state.scrollOffset, [])
    .map((row) => paintRow(row, paletteFor(state), width));
}

/** Private, transient display rows. They are never appended to the transcript. */
export function renderMcpInputRows(state: TuiState, width: number): string[] {
  const modal = state.mcpInput;
  if (!modal) return [];
  const request = modal.request;
  const rows = [`MCP input: ${request.serverId}`, "Private input for this server; excluded from saved conversation history.", "", request.message, ""];
  if (request.mode === "url") {
    rows.push("Open this URL manually and complete the server's flow:", request.url, "", "Then type accept and press Enter. /decline declines; Esc cancels.");
  } else {
    const properties = request.requestedSchema.properties;
    const required = Array.isArray(request.requestedSchema.required) ? request.requestedSchema.required : [];
    const fields: Array<[string, unknown]> = properties && typeof properties === "object" && !Array.isArray(properties) ? Object.entries(properties) : [];
    rows.push("Do not enter passwords, API keys, tokens or secrets. Sign-in belongs in the URL flow.", "Enter a JSON object. Existing defaults are submitted only when you press Enter.", "Fields:");
    for (const [key, field] of fields.slice(0, 32)) {
      rows.push(`${required.includes(key) ? "*" : "-"} ${key}${required.includes(key) ? " (required)" : " (optional)"}: ${JSON.stringify(field)}`);
    }
    rows.push("", "/decline declines; Esc cancels. PgUp/PgDn scroll these fields.");
  }
  if (modal.error) rows.splice(1, 0, modal.error, "");
  return rows.flatMap((line) => sanitizeTerminalText(line).slice(0, 32_768).split("\n").flatMap((part) => wrapDisplayLine(part, Math.max(1, width))));
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "none";
  return String(value);
}

/** Branch name from `git rev-parse --abbrev-ref HEAD` stdout. Empty and failed output stay blank. */
export function parseGitBranch(output: string): string | undefined {
  const line = output.replace(/^﻿/, "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!line || /[\u0000-\u001f\u007f-\u009f]/.test(line)) return undefined;
  return line.length > 200 ? line.slice(0, 200) : line;
}

function finiteUsage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Token text only when a subagent already carries a usage total.
 * Dollar cost only when that same usage already has a numeric cost. Never invented.
 */
function recordedUsage(state: TuiState): { tokens?: number; cost?: number } {
  let tokens = 0;
  let sawTokens = false;
  let cost = 0;
  let sawCost = false;
  for (const task of state.subagents ?? []) {
    const usage = task.tokenUsage as { input?: unknown; output?: unknown; total?: unknown; cost?: unknown } | undefined;
    if (!usage) continue;
    const total = finiteUsage(usage.total);
    const parts = finiteUsage(usage.input) !== undefined || finiteUsage(usage.output) !== undefined
      ? (finiteUsage(usage.input) ?? 0) + (finiteUsage(usage.output) ?? 0)
      : undefined;
    const count = total ?? parts;
    if (count !== undefined) {
      tokens += count;
      sawTokens = true;
    }
    const taskCost = finiteUsage(usage.cost);
    if (taskCost !== undefined) {
      cost += taskCost;
      sawCost = true;
    }
  }
  return {
    tokens: sawTokens ? tokens : undefined,
    cost: sawCost ? cost : undefined,
  };
}

function formatUsage(usage: { tokens?: number; cost?: number }): string {
  const parts: string[] = [];
  if (usage.tokens !== undefined) parts.push(`${usage.tokens} tok`);
  if (usage.cost !== undefined) parts.push(`$${usage.cost}`);
  return parts.join(" ");
}

/** "1 queued" plus the first line of the oldest waiting draft. */
export function formatMessageQueue(queue: readonly string[] | undefined): string | undefined {
  if (!queue || queue.length === 0) return undefined;
  const first = sanitizeTerminalText(redactKnownSecrets(queue[0] ?? "")).split("\n", 1)[0]?.trim() ?? "";
  const label = `${queue.length} queued`;
  return first ? `${label}  ${first}` : label;
}

// -- Status bar ----------------------------------------------------------------

const MODE_TONES: Record<string, Tone> = { guarded: "accent", standard: "text", autonomous: "warn", plan: "hunk", review: "hunk" };

function statusHint(state: TuiState, g: Glyphs): string {
  if (state.mcpInput) return `enter submits ${g.dot} /decline ${g.dot} esc cancels ${g.dot} pgup/pgdn scroll`;
  if (state.picker) return `enter selects ${g.dot} esc closes`;
  if (state.pendingPermission) return `${g.bullet === "*" ? "up/down" : "↑↓"} select ${g.dot} enter confirms ${g.dot} esc declines`;
  if (state.scrollOffset > 0) return `scrolled ${g.dot} pgdn for latest`;
  return "shift+tab to cycle";
}

/** Mode and context hint on the left; runtime, workspace and usage on the right. */
export function renderStatusBar(state: TuiState, width: number): string {
  const g = glyphsFor(state);
  if (state.sharedContext && !state.pendingPermission && !state.mcpInput) {
    const usage = formatUsage(recordedUsage(state));
    const parts = [state.model, state.workflowMode ?? "code", state.sharedContext.effectivePolicy, usage, state.scrollOffset > 0 ? "PgDn latest" : "Ctrl+O activity"] .filter(Boolean);
    return paintRow(fitSpans([{ text: parts.join(` ${g.dot} `), tone: "muted" }], width), paletteFor(state));
  }
  if (state.pendingPermission && !state.mcpInput && width < 64) {
    const hint = `${g.bullet === "*" ? "up/down" : "↑↓ select"} ${g.dot} enter ${g.dot} esc`;
    return paintRow(fitSpans([{ text: hint, tone: "warn" }], width), paletteFor(state));
  }
  const mode = fitVisible(state.sessionMode || "guarded", 16);
  const left: Row = [
    { text: `  ${g.mode} ${mode} mode`, tone: MODE_TONES[mode] ?? "accent" },
    { text: ` ${g.dot} ${statusHint(state, g)}`, tone: "dim" },
  ];
  const place = [state.workspaceName, state.gitBranch ? `(${state.gitBranch})` : undefined].filter(Boolean).join(" ");
  const usage = formatUsage(recordedUsage(state));
  const agents = state.subagents?.length ?? 0;
  const session = fitVisible(state.conversation?.id || state.sessionId || "", 16);
  // Most useful first: narrow terminals truncate from the end.
  const parts = [
    agents > 0 ? `Subagents ${agents}` : "",
    hasProvider(state) ? `${displayValue(state.provider)}/${displayValue(state.model)}` : "no provider",
    usage,
    place,
    session ? `session:${session}` : "",
  ]
    .map((part) => fitVisible(part, width))
    .filter(Boolean);
  // Approval instructions take priority over runtime metadata.
  const withHint = fitSpans(left, width);
  const approvalPending = Boolean(state.pendingPermission) && !state.mcpInput;
  const leftFit = approvalPending || width - rowWidth(withHint) - 3 >= 24 ? withHint : fitSpans(left.slice(0, 1), width);
  const room = width - rowWidth(leftFit) - 3;
  if (room < (approvalPending ? 24 : 8)) return paintRow(leftFit, paletteFor(state));
  // Drop whole trailing segments rather than cutting one mid-word; only the first may be truncated.
  const sep = ` ${g.dot} `;
  let right = parts[0] ? fitVisible(parts[0], room) : "";
  for (const part of parts.slice(1)) {
    const next = right + sep + part;
    if (terminalCellWidth(next) > room) break;
    right = next;
  }
  const rightText = right + " ";
  const gap = width - rowWidth(leftFit) - terminalCellWidth(rightText);
  return paintRow([...leftFit, { text: " ".repeat(Math.max(1, gap)), tone: "text" }, { text: rightText, tone: "muted" }], paletteFor(state));
}

// -- Composer band -------------------------------------------------------------

function composerSpans(row: string, colorEnabled: boolean, prompt: string): Row {
  const spans: Row = [];
  let rest = row;
  if (prompt && rest.startsWith(prompt)) {
    spans.push({ text: prompt, tone: "accent" });
    rest = rest.slice(prompt.length);
  }
  const mark = rest.indexOf(COMPOSER_CURSOR);
  if (mark < 0) return [...spans, { text: rest, tone: "text" }];
  return [
    ...spans,
    { text: rest.slice(0, mark), tone: "text" },
    // A block cell in color; the underscore keeps plain frames readable.
    { text: colorEnabled ? " " : "_", tone: "cursor" },
    { text: rest.slice(mark + COMPOSER_CURSOR.length), tone: "text" },
  ];
}

/** Rounded box around body rows. An optional title sits in the top border. */
function boxRows(body: Row[], width: number, g: Glyphs, tone: Tone, title?: string): Row[] {
  const { tl, tr, bl, br, h, v } = g.box;
  const inner = Math.max(1, width - COMPOSER_BOX_INSET);
  const label = title ? fitVisible(` ${title} `, Math.max(0, width - 4)) : "";
  const top: Row = [
    { text: tl + (label ? h : ""), tone },
    { text: label, tone: tone === "warn" || tone === "gold" ? "warn" : "text" },
    { text: h.repeat(Math.max(0, width - 2 - (label ? 1 : 0) - terminalCellWidth(label))) + tr, tone },
  ];
  return [
    top,
    ...body.map((row): Row => [{ text: `${v} `, tone }, ...padRow(row, inner), { text: ` ${v}`, tone }]),
    [{ text: bl + h.repeat(Math.max(0, width - 2)) + br, tone }],
  ];
}

function formatTurnElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Animation clock. The app redraws on this interval while something moves. */
export const FRAME_MS = 150;
const BEE_LANE = 7;
const FLIGHT = [0, 1, 2, 3, 4, 3, 2, 1];

export function motionFrame(state: Pick<TuiState, "motionEnabled">, now: number): number | undefined {
  return state.motionEnabled ? Math.floor(now / FRAME_MS) : undefined;
}

/**
 * A 3-cell bee that flies back and forth across a 7-cell lane, flapping each
 * frame and leaving a dot where it just was. Without motion it rests in place.
 */
function flyingBee(g: Glyphs, frame: number | undefined): Row {
  const { open, folded, body, trail } = g.bee;
  const wings = frame === undefined || frame % 2 === 0 ? open : folded;
  const bee: Row = [{ text: wings[0], tone: "pale" }, { text: body, tone: "gold" }, { text: wings[1], tone: "pale" }];
  if (frame === undefined) return bee;
  const step = frame % FLIGHT.length;
  const at = FLIGHT[step];
  const from = FLIGHT[(step + FLIGHT.length - 1) % FLIGHT.length];
  const before = " ".repeat(at).split("");
  const after = " ".repeat(BEE_LANE - 3 - at).split("");
  if (from < at) before[at - 1] = trail;
  else if (from > at) after[0] = trail;
  return [{ text: before.join(""), tone: "dim" }, ...bee, { text: after.join(""), tone: "dim" }];
}

/** A two-cell highlight that sweeps across the label, then pauses off the end. */
function shimmer(text: string, frame: number | undefined): Row {
  if (frame === undefined) return [{ text, tone: "lavender" }];
  const chars = [...text];
  const at = (frame % (chars.length + 6)) - 2;
  const lo = Math.max(0, at);
  const hi = Math.max(lo, Math.min(chars.length, at + 2));
  return [
    { text: chars.slice(0, lo).join(""), tone: "lavender" },
    { text: chars.slice(lo, hi).join(""), tone: "pale" },
    { text: chars.slice(hi).join(""), tone: "lavender" },
  ];
}

/** "ʚ●ɞ Working… (12s · 3 agents · esc to interrupt)". The bee flies only when motion is on. */
function workingRow(state: TuiState, g: Glyphs, now: number): Row {
  if (state.sharedContext) {
    const elapsed = state.turnStartedAt === undefined ? "" : ` ${formatTurnElapsed(now - state.turnStartedAt)}`;
    return [{ text: `${state.sharedContext.status}${elapsed} ${g.dot} Ctrl+C or /stop`, tone: "muted" }];
  }
  const frame = motionFrame(state, now);
  const details: string[] = [];
  if (state.turnStartedAt !== undefined) details.push(formatTurnElapsed(now - state.turnStartedAt));
  const agents = state.subagents?.length ?? 0;
  if (agents > 0) details.push(`${agents} agent${agents === 1 ? "" : "s"}`);
  const usage = formatUsage(recordedUsage(state));
  if (usage) details.push(usage);
  details.push("esc to interrupt");
  return [
    ...flyingBee(g, frame),
    { text: " ", tone: "text" },
    ...shimmer(`${state.taskStatus === "verifying" ? "Verifying" : "Working"}${g.ellipsis}`, frame),
    { text: ` (${details.join(` ${g.dot} `)})`, tone: "dim" },
  ];
}

const PERMISSION_PULSE_MS = 1200;

/** The selector border flashes gold twice when it opens, then holds amber. */
export function permissionPulsing(state: Pick<TuiState, "motionEnabled" | "pendingPermission" | "permissionAskedAt">, now: number): boolean {
  const since = state.permissionAskedAt === undefined ? Infinity : now - state.permissionAskedAt;
  return Boolean(state.motionEnabled && state.pendingPermission) && since < PERMISSION_PULSE_MS;
}

/** Numbered allow / decline options. Typing still works and is echoed in the box. */
function selectorBody(state: TuiState, g: Glyphs): Row[] {
  const choice = state.permissionChoice === 1 ? 1 : 0;
  const options = ["Yes", "No"];
  const rows: Row[] = options.map((option, index): Row => [
    { text: index === choice ? `${g.focus} ` : "  ", tone: "accent" },
    { text: `${index + 1}. ${option}`, tone: index === choice ? "accent" : "text" },
    { text: index === 1 ? " (esc)" : "", tone: "dim" },
  ]);
  if ((state.input ?? "").length > 0) {
    rows.push(composerSpans(`> ${state.input}${COMPOSER_CURSOR}`.replace(/\n/g, " "), state.colorEnabled, "> "));
  }
  return rows;
}

/**
 * Working and queue lines, then the input box, or the permission selector
 * while a decision is pending. Short terminals drop the box borders.
 */
export function renderComposerBand(state: TuiState, width: number, composerRows: number, now = Date.now()): string[] {
  if (composerRows <= 0) return [];
  const g = glyphsFor(state);
  const paint = (row: Row) => paintRow(fitSpans(row, width), paletteFor(state));
  const prompt = boxPrompt(state);
  const activity: Row[] = [];
  if (state.taskStatus === "running" || state.taskStatus === "verifying") activity.push(workingRow(state, g, now));
  const queueText = state.mcpInput ? undefined : formatMessageQueue(state.messageQueue);
  if (queueText) activity.push([{ text: `  ${queueText}`, tone: "dim" }]);

  if (state.pendingPermission && !state.mcpInput) {
    const title = permissionDisplayPrompt(state);
    const context = permissionContextRows(state, width);
    const body: Row[] = [
      ...context.map((text): Row => [{ text, tone: "text" }]),
      ...(context.length > 0 ? [[]] : []),
      ...selectorBody(state, g),
    ];
    const since = now - (state.permissionAskedAt ?? now);
    const flash = permissionPulsing(state, now) && Math.floor(since / 300) % 2 === 0;
    const box = boxRows(body, width, g, flash ? "gold" : "warn", context.length > 0 ? "Approval" : title);
    if (box.length <= composerRows) return [...activity.slice(0, composerRows - box.length), ...box].map(paint);

    // A short viewport still shows the request and the actual highlighted choice.
    const choice = state.permissionChoice === 1 ? "1.Yes / [2.No]" : "[1.Yes] / 2.No";
    const options: Row = [
      { text: choice, tone: "accent" },
      { text: state.input ? ` > ${sanitizeTerminalText(state.input).replace(/\n/g, " ")}_` : "", tone: "text" },
    ];
    if (composerRows === 1) return [paint([...options, { text: ` ${g.dot} ${title}`, tone: "warn" }])];
    const request = wrapDisplayLine(title, Math.max(1, width), true);
    const budget = composerRows - 1;
    const visible = request.slice(0, budget);
    if (request.length > budget) visible[budget - 1] = fitVisible(visible[budget - 1] ?? "", Math.max(0, width - terminalCellWidth(g.ellipsis))) + g.ellipsis;
    return [...visible.map((text): Row => [{ text, tone: "warn" }]), options].map(paint);
  }

  if (composerRows < 3) {
    const layout = layoutComposer(state.input ?? "", state.cursor, width, prompt);
    const line = composerSpans(visibleComposerRows(layout, 1)[0] ?? prompt, state.colorEnabled, prompt);
    return (composerRows <= 1 ? [line] : [activity[0] ?? [], line]).map(paint);
  }

  const inner = Math.max(1, width - COMPOSER_BOX_INSET);
  const layout = layoutComposer(state.input ?? "", state.cursor, inner, prompt);
  const textBudget = Math.max(1, composerRows - 2 - activity.length);
  const text = visibleComposerRows(layout, textBudget).map((row) => composerSpans(row, state.colorEnabled, prompt));
  return [...activity, ...boxRows(text, width, g, "dim")].slice(-composerRows).map(paint);
}

// -- Full Screen Render --------------------------------------------------------

export function renderTuiScreen(state: TuiState, now = Date.now()): string {
  const termWidth = state.width > 0 ? state.width : 40;
  const width = sessionFrameWidth(termWidth);
  const height = sessionFrameHeight(state.height);
  const colorEnabled = state.colorEnabled;
  const modalState = state.mcpInput ? { ...state, subagentsExpanded: false, picker: undefined, messageQueue: [] } : state;
  const subagentLines = expandedSubagentLines(modalState, width);
  const plan = planSessionFrame(modalState);
  const pickerLines = renderPickerRows(modalState, plan.pickerRows);

  const lines: string[] = [];
  if (state.sharedContext) {
    const reserved = Math.min(3, Math.max(0, height - plan.statusRows - plan.subagentRows - plan.pickerRows - plan.composerRows - plan.transcriptRows));
    const g = glyphsFor(state);
    const branch = state.gitBranch ? ` ${g.dot} ${state.gitBranch}` : "";
    const header = [`HIVE ${g.dot} ${state.sharedContext.project} ${g.dot} ${state.sharedContext.status}${state.sharedContext.archived ? ` ${g.dot} archived` : ""}`, `${truncateMiddle(state.sharedContext.path, Math.max(8, width - terminalCellWidth(branch)), g.ellipsis)}${branch}`, `Session: ${state.sharedContext.session} ${g.dot} /sessions /projects`];
    lines.push(...header.slice(0, reserved).map((text, index) => paintRow([{ text: fitVisible(text, width), tone: index === 0 ? "accent" : "muted" }], paletteFor(state))));
  }
  const modalRows = state.mcpInput ? renderMcpInputRows(state, width) : undefined;
  const mainRows = modalRows
    ? modalRows.slice(state.mcpInput?.scrollOffset ?? 0, (state.mcpInput?.scrollOffset ?? 0) + plan.transcriptRows).map((line) => paintRow([{ text: fitVisible(line, width), tone: "text" }], paletteFor(state)))
    : renderMainPanel(state, plan.transcriptRows, now);
  for (const line of mainRows) {
    lines.push(fitStyledTerminalText(line, width));
  }
  if (modalRows) for (let index = mainRows.length; index < plan.transcriptRows; index += 1) lines.push("");
  for (const line of subagentLines.slice(0, plan.subagentRows)) {
    lines.push(fitStyledTerminalText(line, width));
  }
  for (const line of renderComposerBand(state, width, plan.composerRows, now).slice(0, plan.composerRows)) {
    lines.push(fitStyledTerminalText(line, width));
  }
  for (const line of pickerLines.slice(0, plan.pickerRows)) {
    lines.push(fitStyledTerminalText(line, width));
  }
  if (plan.statusRows > 0) lines.push(fitStyledTerminalText(renderStatusBar(state, width), width));

  const framed = lines.slice(0, height);
  while (framed.length < height) framed.push("");
  if (termWidth > width) {
    const leftPad = Math.floor((termWidth - width) / 2);
    const spaces = rep(" ", leftPad);
    return framed.map((line) => spaces + line).join("\n");
  }
  return framed.join("\n");
}
