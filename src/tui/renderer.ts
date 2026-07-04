/**
 * renderer.ts
 * Pure render functions for the HIVE TUI cockpit.
 * All output is ASCII-safe. ANSI color applied conditionally via state.colorEnabled.
 */

import { TuiState } from "./state.js";
import {
  getWideHiveTitle,
  getCompactHiveTitle,
  getLargeHoneycombAscii,
  getSmallHoneycombAscii,
  renderHivePixelWordmark
} from "../ui/banner.js";
import {
  stripAnsi,
  gradientText,
  applyColor,
  TERMINAL_LINE_GRADIENT,
  BRAND_COLORS,
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

function safeClampLine(text: string, maxCols: number): string {
  const bare = stripAnsi(text);
  if (bare.length <= maxCols) return text;
  // If we must clamp, we just strip ANSI to avoid leaking unclosed color tags.
  // Then we crop and return raw ascii.
  return bare.slice(0, maxCols);
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

function contentRow(left: string, width: number, useColor: boolean): string {
  const p = pipe(useColor);
  const innerW = width - 2;
  const bareLen = stripAnsi(left).length;
  if (bareLen > innerW) {
    const clamped = safeClampLine(left, innerW);
    return p + clamped + p;
  }
  const trail = rep(" ", innerW - bareLen);
  return p + left + trail + p;
}

// -- Right Panel ---------------------------------------------------------------

export function renderHelpPanel(state: TuiState, useColor: boolean, width: number, height: number): string[] {
  if (state.transcript && state.transcript.length > 0 && state.taskStatus !== "idle") {
    const lines = state.transcript.slice(-Math.max(1, height));
    return lines.map(l => {
      if (!useColor) return "  " + l;
      if (l.startsWith("[HIVE]")) return "  " + applyColor(l, BRAND_COLORS.primary_bright.r, BRAND_COLORS.primary_bright.g, BRAND_COLORS.primary_bright.b);
      if (l.startsWith("[Error]")) return "  " + applyColor(l, 255, 100, 100);
      return "  " + applyColor(l, BRAND_COLORS.muted.r, BRAND_COLORS.muted.g, BRAND_COLORS.muted.b);
    });
  }

  const HELP_PANEL_LINES = [
    "HIVE CLI/IDE COMMAND COCKPIT",
    rep("-", width),
    "Welcome to HIVE.",
    "Your terminal-native workspace for intelligent engineering.",
    "",
    "> Type /help to explore available commands",
    "> Type /providers to inspect providers",
    "> Type /status to view runtime status",
    "> Type /model to select model",
    "> Type /update to check for updates",
    "",
    "TIP",
    "Press Shift+Tab to toggle permissions mode.",
    "HIVE is built for focus, built for builders.",
    "",
    "Ready when you are.",
  ];

  return HELP_PANEL_LINES.map((l) => {
    if (l === "" || !useColor) return l;
    if (l === "HIVE CLI/IDE COMMAND COCKPIT" || l === "TIP") {
      return applyColor(l, BRAND_COLORS.accent.r, BRAND_COLORS.accent.g, BRAND_COLORS.accent.b);
    }
    if (l.startsWith("> /")) {
      const parts = l.split(" ");
      const arrow = parts[0];
      const cmd = parts[1];
      const rest = parts.slice(2).join(" ");
      const cCmd = applyColor(cmd, BRAND_COLORS.primary_bright.r, BRAND_COLORS.primary_bright.g, BRAND_COLORS.primary_bright.b);
      return applyColor(arrow, BRAND_COLORS.muted.r, BRAND_COLORS.muted.g, BRAND_COLORS.muted.b) + " " + cCmd + " " + rest;
    }
    if (l.startsWith("-")) {
      return gradientText(l, TERMINAL_LINE_GRADIENT);
    }
    return applyColor(l, BRAND_COLORS.muted.r, BRAND_COLORS.muted.g, BRAND_COLORS.muted.b);
  });
}

// -- Lower Dashboard -----------------------------------------------------------

function renderLowerPanels(width: number, useColor: boolean): string[] {
  if (width < 100) return [];
  
  const cols3 = width >= 120;
  
  const col1 = [
    "BRAND KIT / COLOR PALETTE",
    "Deep Violet        #5B21B6",
    "Vivid Violet       #7C3AED",
    "Lavender           #A78BFA",
    "Pale Highlight     #DDD6FE",
    "Neon Line Accent   #8B5CF6",
    "Background         #08080B",
    "Muted Text         #9CA3AF"
  ];
  
  const col2 = [
    "TYPOGRAPHY",
    "Display: pixel/block bitmap style",
    "Interface: clean mono terminal style",
    "",
    "DISPLAY EXAMPLE",
    useColor ? "## HIVE" : "## HIVE" // Small example
  ];

  const col3 = [
    "RUNTIME / BRAND NOTE",
    "HIVE - Hyper Intelligence for Verified Engineering.",
    "provider: <provider>",
    "model: <model>",
    "mode: <mode>",
    "agents: <n>",
    "ctx: <n>%",
    "",
    "BRAND TRAITS",
    "[#] retro-tech",
    "[#] ASCII-safe",
    "[#] violet gradient",
    "[#] terminal-native"
  ];
  
  const c1w = 32;
  const c2w = 36;
  const c3w = 40;
  
  const lines: string[] = [];
  lines.push(hBorder(width, useColor));
  
  for (let i = 0; i < 13; i++) {
    if (!col1[i] && !col2[i] && !col3[i]) continue;
    const styleItem = (text: string, title: boolean) => {
      if (!useColor) return text;
      if (title) return applyColor(text, BRAND_COLORS.accent.r, BRAND_COLORS.accent.g, BRAND_COLORS.accent.b);
      return applyColor(text, BRAND_COLORS.muted.r, BRAND_COLORS.muted.g, BRAND_COLORS.muted.b);
    };

    const t1 = styleItem(padRight(col1[i] || "", c1w), i === 0);
    const t2 = styleItem(padRight(col2[i] || "", c2w), i === 0);
    const t3 = cols3 ? styleItem(padRight(col3[i] || "", c3w), i === 0) : "";
    
    let inner = "";
    if (cols3) {
      const gap = Math.max(2, Math.floor((width - 4 - c1w - c2w - c3w) / 2));
      inner = t1 + rep(" ", gap) + t2 + rep(" ", gap) + t3;
    } else {
      const gap = Math.max(2, width - 4 - c1w - c2w);
      inner = t1 + rep(" ", gap) + t2;
    }
    
    lines.push(contentRow(inner, width, useColor));
  }
  
  return lines;
}

// -- Main Panel: output history ------------------------------------------------

export function renderMainPanel(
  state: TuiState,
  availableRows: number
): string[] {
  const { outputLines, transcript } = state;
  // If we are showing transcript in the main panel because it is too large for the right panel:
  if (transcript && transcript.length > 0 && state.taskStatus !== "idle") {
     return transcript.slice(-Math.max(1, availableRows)).map(l => "  " + l);
  }
  return outputLines.slice(-Math.max(1, availableRows));
}

// -- Input Row -----------------------------------------------------------------

export function renderInputRow(state: TuiState): string {
  const prompt = state.running
    ? "  [running...] "
    : "  > ";
  const cursor = state.colorEnabled
    ? applyColor("_", BRAND_COLORS.accent.r, BRAND_COLORS.accent.g, BRAND_COLORS.accent.b)
    : "_";
  
  const text = state.colorEnabled 
    ? applyColor(state.input, BRAND_COLORS.text.r, BRAND_COLORS.text.g, BRAND_COLORS.text.b)
    : state.input;
    
  return prompt + text + cursor;
}

// -- Footer / Status Rail ------------------------------------------------------

export function renderFooter(state: TuiState, width: number): string {
  const { provider, model, mode, agents, contextPercent, colorEnabled } = state;

  const sep = colorEnabled
    ? applyColor(" - ", BRAND_COLORS.dim.r, BRAND_COLORS.dim.g, BRAND_COLORS.dim.b)
    : " - ";

  function field(label: string, value: string | number | undefined | null): string {
    const valStr = value === undefined || value === null ? "none" : String(value);
    const lbl = colorEnabled
      ? applyColor(label + ":", BRAND_COLORS.muted.r, BRAND_COLORS.muted.g, BRAND_COLORS.muted.b)
      : label + ":";
    const val = colorEnabled
      ? applyColor(valStr, BRAND_COLORS.text.r, BRAND_COLORS.text.g, BRAND_COLORS.text.b)
      : valStr;
    return lbl + val;
  }

  const leftParts = [
    colorEnabled ? applyColor("[default]", BRAND_COLORS.accent.r, BRAND_COLORS.accent.g, BRAND_COLORS.accent.b) : "[default]",
    colorEnabled ? applyColor("hive main", BRAND_COLORS.muted.r, BRAND_COLORS.muted.g, BRAND_COLORS.muted.b) : "hive main",
    field("status", state.taskStatus || "idle"),
    field("provider", provider),
    field("model", model),
    field("agents", agents),
    field("ctx", contextPercent + "%")
  ];

  const left = leftParts.join(sep);
  const rightRaw = state.taskStatus === "running" || state.taskStatus === "verifying" ? "Ctrl+C cancel" : "update: hive update  /help";
  const right = colorEnabled
    ? applyColor(rightRaw, BRAND_COLORS.muted.r, BRAND_COLORS.muted.g, BRAND_COLORS.muted.b)
    : rightRaw;

  const leftLen = stripAnsi(left).length;
  const rightLen = stripAnsi(right).length;
  const innerW = width - 2;

  let finalLeft = left;
  let finalLeftLen = leftLen;
  const maxLeftLen = Math.max(10, innerW - rightLen - 4);
  
  if (leftLen > maxLeftLen) {
    finalLeft = safeClampLine(left, maxLeftLen - 3) + "...";
    finalLeftLen = stripAnsi(finalLeft).length;
  }

  const gap = Math.max(1, innerW - finalLeftLen - rightLen - 2);

  const p = pipe(colorEnabled);
  const trail = rep(" ", gap);
  return p + " " + finalLeft + trail + right + " " + p;
}

// -- Full Screen Render --------------------------------------------------------

export function renderTuiScreen(state: TuiState): string {
  const { width: termWidth, height, colorEnabled } = state;
  
  const MAX_WIDTH = 160;
  const actualWidth = Math.max(40, Math.min(termWidth, MAX_WIDTH));
  
  if (termWidth < 70) {
    return [
      hBorder(actualWidth, colorEnabled),
      contentRow("HIVE TUI - Window too small", actualWidth, colorEnabled),
      contentRow("Please resize width >= 70", actualWidth, colorEnabled),
      contentRow(renderInputRow(state), actualWidth, colorEnabled),
      hBorder(actualWidth, colorEnabled)
    ].join("\n");
  }

  const useWideTitle = actualWidth >= 120;
  
  const titleLines = useWideTitle ? renderHivePixelWordmark({ colorEnabled, width: "wide" }) : getCompactHiveTitle(colorEnabled);
  const motifLines = useWideTitle ? getLargeHoneycombAscii(colorEnabled) : getSmallHoneycombAscii(colorEnabled);
  
  const leftColLines = [
    ...titleLines,
    "",
    ...motifLines
  ];

  const leftColW = useWideTitle ? 76 : 30;
  const rightPanelW = Math.max(30, actualWidth - leftColW - 6);
  const rightPanelLines = renderHelpPanel(state, colorEnabled, rightPanelW, leftColLines.length);

  const lowerPanels = renderLowerPanels(actualWidth, colorEnabled);
  
  const FIXED_ROWS = 1 + // top border
                     1 + // blank above title
                     1 + // bottom border of top section
                     1 + // input border top
                     1 + // input row
                     1 + // input border bottom
                     1 + // footer
                     1 + // footer border bottom
                     lowerPanels.length;

  const frameContentRows = Math.max(leftColLines.length, rightPanelLines.length);
  const outputRows = Math.max(2, height - FIXED_ROWS - frameContentRows - 1);

  const lines: string[] = [];
  const border = hBorder(actualWidth, colorEnabled);
  const blank = blankRow(actualWidth, colorEnabled);

  lines.push(border);
  lines.push(blank);

  for (let i = 0; i < frameContentRows; i++) {
    const leftRaw = leftColLines[i] || "";
    const rightRaw = rightPanelLines[i] || "";

    const leftStr = padRight(leftRaw, leftColW);
    const rightStr = padRight(rightRaw, rightPanelW);
    
    const clampedR = safeClampLine(rightStr, rightPanelW);

    const inner = leftStr + "  " + clampedR;
    const innerBare = stripAnsi(inner);
    const totalInnerW = actualWidth - 4; 
    
    const trail = rep(" ", Math.max(0, totalInnerW - innerBare.length));
    
    const p = pipe(colorEnabled);
    lines.push(p + " " + inner + trail + " " + p);
  }

  lines.push(blank);
  lines.push(border);
  
  const outputPanel = renderMainPanel(state, outputRows);
  for (const outLine of outputPanel) {
    const colored = colorEnabled
      ? applyColor(outLine, BRAND_COLORS.text.r, BRAND_COLORS.text.g, BRAND_COLORS.text.b)
      : outLine;
    lines.push(contentRow(colored, actualWidth, colorEnabled));
  }

  if (lowerPanels.length > 0) {
    for (const pLine of lowerPanels) {
      lines.push(pLine);
    }
  }

  lines.push(border);
  lines.push(contentRow(renderInputRow(state), actualWidth, colorEnabled));
  lines.push(border);
  lines.push(renderFooter(state, actualWidth));
  lines.push(border);

  if (termWidth > MAX_WIDTH) {
    const leftPad = Math.floor((termWidth - MAX_WIDTH) / 2);
    const spaces = rep(" ", leftPad);
    return lines.map(l => spaces + l).join("\n");
  }

  return lines.join("\n");
}
