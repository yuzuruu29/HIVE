/**
 * renderer.ts
 * Pure render functions for the HIVE TUI cockpit.
 * All output is ASCII-safe. ANSI color applied conditionally via state.colorEnabled.
 */

import { TuiState } from "./state.js";
import {
  getLargeHiveTitle,
  getQueenBeeAscii,
} from "../ui/banner.js";
import {
  stripAnsi,
  gradientText,
  applyColor,
  TERMINAL_LINE_GRADIENT,
  BRAND_COLORS,
  VIOLET_GRADIENT,
} from "../ui/colors.js";

// -- Helpers -------------------------------------------------------------------

function rep(char: string, count: number): string {
  if (count <= 0) return "";
  return char.repeat(count);
}

function padRight(text: string, width: number): string {
  const bare = stripAnsi(text);
  const pad = width - bare.length;
  return text + (pad > 0 ? rep(" ", pad) : "");
}

function clampLine(text: string, maxCols: number): string {
  const bare = stripAnsi(text);
  if (bare.length <= maxCols) return text;
  // Truncate raw visible characters, keeping ANSI prefix
  return bare.slice(0, maxCols - 1);
}

function hBorder(width: number, useColor: boolean): string {
  const dashes = rep("-", width - 2);
  const line = "+" + dashes + "+";
  return useColor ? gradientText(line, TERMINAL_LINE_GRADIENT) : line;
}

function pipe(useColor: boolean): string {
  return useColor ? gradientText("|", TERMINAL_LINE_GRADIENT) : "|";
}

function blankRow(width: number, useColor: boolean): string {
  const p = pipe(useColor);
  return p + rep(" ", width - 2) + p;
}

function contentRow(
  left: string,
  width: number,
  useColor: boolean
): string {
  const p = pipe(useColor);
  const innerW = width - 2;
  const padded = padRight(left, innerW);
  const clamped = clampLine(padded, innerW);
  // Ensure exactly innerW visible chars
  const bare = stripAnsi(clamped);
  const trail = rep(" ", Math.max(0, innerW - bare.length));
  return p + clamped + trail + p;
}

// -- Right Panel ---------------------------------------------------------------

const HELP_PANEL_LINES = [
  "HIVE COMMAND COCKPIT",
  "----------------------------------------------------",
  "/help       show commands",
  "/providers  inspect providers",
  "/model      select model",
  "/run        execute task",
  "/clear      clear output",
  "/exit       quit HIVE",
  "",
  "Plain text = task prompt.",
  "Ctrl+C exits at any time.",
];

export function renderHelpPanel(
  _state: TuiState,
  useColor: boolean
): string[] {
  return HELP_PANEL_LINES.map((l) => {
    if (l === "" || !useColor) return l;
    if (l === "HIVE COMMAND COCKPIT") {
      return applyColor(
        l,
        BRAND_COLORS.accent.r,
        BRAND_COLORS.accent.g,
        BRAND_COLORS.accent.b
      );
    }
    if (l.startsWith("/")) {
      const [cmd, ...rest] = l.split(/\s+/);
      const coloredCmd = applyColor(
        cmd,
        BRAND_COLORS.primary_bright.r,
        BRAND_COLORS.primary_bright.g,
        BRAND_COLORS.primary_bright.b
      );
      return coloredCmd + " " + rest.join(" ");
    }
    return applyColor(
      l,
      BRAND_COLORS.muted.r,
      BRAND_COLORS.muted.g,
      BRAND_COLORS.muted.b
    );
  });
}

// -- Main Panel: output history ------------------------------------------------

export function renderMainPanel(
  state: TuiState,
  availableRows: number
): string[] {
  const { outputLines } = state;
  // Take last availableRows lines
  return outputLines.slice(-Math.max(1, availableRows));
}

// -- Input Row -----------------------------------------------------------------

export function renderInputRow(state: TuiState): string {
  const prompt = state.running
    ? "  [running...] "
    : "  > ";
  const cursor = state.colorEnabled
    ? applyColor(
        "_",
        BRAND_COLORS.accent.r,
        BRAND_COLORS.accent.g,
        BRAND_COLORS.accent.b
      )
    : "_";
  return prompt + state.input + cursor;
}

// -- Footer / Status Rail ------------------------------------------------------

export function renderFooter(state: TuiState): string {
  const { provider, model, mode, agents, contextPercent, colorEnabled } =
    state;

  const sep = colorEnabled
    ? applyColor(
        " - ",
        BRAND_COLORS.dim.r,
        BRAND_COLORS.dim.g,
        BRAND_COLORS.dim.b
      )
    : " - ";

  function field(label: string, value: string | number): string {
    const lbl = colorEnabled
      ? applyColor(
          label + ":",
          BRAND_COLORS.muted.r,
          BRAND_COLORS.muted.g,
          BRAND_COLORS.muted.b
        )
      : label + ":";
    const val = colorEnabled
      ? applyColor(
          String(value),
          BRAND_COLORS.text.r,
          BRAND_COLORS.text.g,
          BRAND_COLORS.text.b
        )
      : String(value);
    return lbl + val;
  }

  const leftParts = [
    "default",
    field("provider", provider),
    field("model", model),
    field("mode", mode),
    field("agents", agents),
    field("ctx", contextPercent + "%"),
  ];

  const left = leftParts.join(sep);

  const rightRaw = "/help  Ctrl+C";
  const right = colorEnabled
    ? applyColor(
        rightRaw,
        BRAND_COLORS.muted.r,
        BRAND_COLORS.muted.g,
        BRAND_COLORS.muted.b
      )
    : rightRaw;

  const leftLen = stripAnsi(left).length;
  const rightLen = stripAnsi(right).length;
  const gap = Math.max(1, state.width - leftLen - rightLen);

  return left + rep(" ", gap) + right;
}

// -- Full Screen Render --------------------------------------------------------

export function renderTuiScreen(state: TuiState): string {
  const { width, height, colorEnabled } = state;
  const safeW = Math.max(width, 40);

  // Layout:
  //   1 row  = top border
  //   N rows = main content (title + bee + right panel interleaved)
  //   1 row  = blank separator
  //   1 row  = bottom border of top section
  //   1 row  = input row line
  //   1 row  = input border
  //   1 row  = footer
  // We want the main panel to fill the available height.

  // Fixed structural rows:
  const FIXED_ROWS =
    1 + // top border
    1 + // blank above title
    1 + // blank below bee
    1 + // bottom border (top section)
    1 + // input border top
    1 + // input row
    1 + // input border bottom
    1; // footer

  const titleLines = getLargeHiveTitle(colorEnabled); // 5 lines
  const beeLines = getQueenBeeAscii(colorEnabled); // 5 lines
  const leftColLines = [...titleLines, "", ...beeLines]; // 11 lines
  const rightPanelLines = renderHelpPanel(state, colorEnabled);

  // Main frame content height = max(leftColLines, rightPanelLines)
  const frameContentRows = Math.max(leftColLines.length, rightPanelLines.length);

  // Output panel rows = remaining after all fixed + frame content
  const outputRows = Math.max(
    2,
    height - FIXED_ROWS - frameContentRows - 2
  );

  const outputPanel = renderMainPanel(state, outputRows);

  const lines: string[] = [];
  const border = hBorder(safeW, colorEnabled);
  const blank = blankRow(safeW, colorEnabled);

  // Top border
  lines.push(border);

  // Blank spacer inside top section
  lines.push(blank);

  // Interleaved title+bee (left) and help panel (right)
  const leftColW = 36;
  const rightStart = leftColW + 4; // padding
  const rightW = Math.max(0, safeW - 2 - rightStart - 2);

  for (let i = 0; i < frameContentRows; i++) {
    const leftRaw = leftColLines[i] || "";
    const rightRaw = rightPanelLines[i] || "";

    const leftPadded = padRight(leftRaw, leftColW);
    const rightClamped = clampLine(rightRaw, rightW);
    const rightBareLen = stripAnsi(rightClamped).length;
    const rightTrail = rep(" ", Math.max(0, rightW - rightBareLen));

    const inner = leftPadded + "    " + rightClamped + rightTrail;
    const innerBare = stripAnsi(inner);
    const totalInnerW = safeW - 2 - 2; // -2 pipes, -2 margin spaces
    const trail = rep(" ", Math.max(0, totalInnerW - innerBare.length));

    const p = pipe(colorEnabled);
    lines.push(p + "  " + inner + trail + p);
  }

  // Blank spacer
  lines.push(blank);

  // Output panel lines (inside border)
  for (const outLine of outputPanel) {
    const colored = colorEnabled
      ? applyColor(
          outLine,
          BRAND_COLORS.text.r,
          BRAND_COLORS.text.g,
          BRAND_COLORS.text.b
        )
      : outLine;
    lines.push(contentRow(colored, safeW, colorEnabled));
  }

  // Input section border
  lines.push(border);

  // Input row
  const inputContent = renderInputRow(state);
  lines.push(contentRow(inputContent, safeW, colorEnabled));

  // Input section bottom border
  lines.push(border);

  // Footer / status rail
  lines.push(renderFooter(state));

  return lines.join("\n");
}
