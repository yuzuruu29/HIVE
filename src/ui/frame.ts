import { getLargeHiveTitle, getQueenBeeAscii, getCompactQueenBeeAscii, getHiveTextBanner } from "./banner.js";
import { TERMINAL_LINE_GRADIENT, gradientText, BRAND_COLORS, applyColor, stripAnsi } from "./colors.js";
import fs from "fs";

function getVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
    return `v${pkg.version}`;
  } catch {
    return "v0.x.x";
  }
}

function repeatChar(char: string, count: number): string {
  return new Array(Math.max(0, count + 1)).join(char);
}

function padRight(text: string, width: number): string {
  const stripped = stripAnsi(text);
  if (stripped.length >= width) return text;
  return text + repeatChar(" ", width - stripped.length);
}

function padLeft(text: string, width: number): string {
  const stripped = stripAnsi(text);
  if (stripped.length >= width) return text;
  return repeatChar(" ", width - stripped.length) + text;
}

export function renderStartupFrame(width: number, useColor: boolean): string {
  const safeW = Math.max(width, 100);
  const borderH = repeatChar("-", safeW - 2);
  const topBorder = useColor ? gradientText("+" + borderH + "+", TERMINAL_LINE_GRADIENT) : "+" + borderH + "+";
  const bottomBorder = topBorder;

  const titleLines = getLargeHiveTitle(useColor);
  const beeLines = getQueenBeeAscii(useColor);
  
  const rightLines = [
    "HIVE CLI/IDE COMMAND COCKPIT",
    useColor ? gradientText(repeatChar("-", 58), TERMINAL_LINE_GRADIENT) : repeatChar("-", 58),
    "Welcome to HIVE.",
    "Terminal-native intelligence for verified agentic builds.",
    "",
    "Type /help to explore commands.",
    "Run hive providers setup to configure models.",
    "Run hive providers status to inspect provider health.",
    "",
    "TIP: Use Shift+Tab to toggle permissions mode."
  ];

  const content: string[] = [];
  content.push(useColor ? gradientText("|", TERMINAL_LINE_GRADIENT) + repeatChar(" ", safeW - 2) + gradientText("|", TERMINAL_LINE_GRADIENT) : "|" + repeatChar(" ", safeW - 2) + "|");
  
  const maxLines = Math.max(titleLines.length + beeLines.length + 1, rightLines.length);
  const leftColW = 34;
  
  for (let i = 0; i < maxLines; i++) {
    let left = "";
    if (i < titleLines.length) {
      left = titleLines[i];
    } else if (i === titleLines.length) {
      left = "";
    } else {
      const beeIdx = i - titleLines.length - 1;
      if (beeIdx < beeLines.length) {
        left = beeLines[beeIdx];
      }
    }
    
    const right = rightLines[i] || "";
    const leftPad = padRight(left, leftColW);
    const middlePad = "    ";
    const rightContent = right;
    
    const rawLen = stripAnsi(leftPad).length + middlePad.length + stripAnsi(rightContent).length;
    const remaining = safeW - 2 - rawLen - 2; // -2 for margins
    const rightPadStr = repeatChar(" ", Math.max(0, remaining));
    
    const pipe = useColor ? gradientText("|", TERMINAL_LINE_GRADIENT) : "|";
    content.push(pipe + "  " + leftPad + middlePad + rightContent + rightPadStr + pipe);
  }

  content.push(useColor ? gradientText("|", TERMINAL_LINE_GRADIENT) + repeatChar(" ", safeW - 2) + gradientText("|", TERMINAL_LINE_GRADIENT) : "|" + repeatChar(" ", safeW - 2) + "|");
  
  const footer1 = "HYPER INTELLIGENCE FOR VERIFIED ENGINEERING";
  const footer2 = `${getVersion()} - ${process.cwd()}`;
  
  const pipe = useColor ? gradientText("|", TERMINAL_LINE_GRADIENT) : "|";
  content.push(pipe + "  " + padRight(useColor ? applyColor(footer1, BRAND_COLORS.muted.r, BRAND_COLORS.muted.g, BRAND_COLORS.muted.b) : footer1, safeW - 4) + pipe);
  content.push(pipe + "  " + padRight(useColor ? applyColor(footer2, BRAND_COLORS.dim.r, BRAND_COLORS.dim.g, BRAND_COLORS.dim.b) : footer2, safeW - 4) + pipe);
  
  content.push(useColor ? gradientText("|", TERMINAL_LINE_GRADIENT) + repeatChar(" ", safeW - 2) + gradientText("|", TERMINAL_LINE_GRADIENT) : "|" + repeatChar(" ", safeW - 2) + "|");
  
  return [topBorder, ...content, bottomBorder].join("\n");
}

export function renderCompactStartupFrame(width: number, useColor: boolean): string {
  const safeW = Math.max(width, 70);
  const borderH = repeatChar("-", safeW - 2);
  const topBorder = useColor ? gradientText("+" + borderH + "+", TERMINAL_LINE_GRADIENT) : "+" + borderH + "+";
  const bottomBorder = topBorder;

  const beeLines = getCompactQueenBeeAscii(useColor);
  const banner = getHiveTextBanner(useColor);
  const subtitle = "Terminal-native intelligence for verified builds.";
  
  const content: string[] = [];
  const pipe = useColor ? gradientText("|", TERMINAL_LINE_GRADIENT) : "|";
  
  content.push(pipe + repeatChar(" ", safeW - 2) + pipe);
  content.push(pipe + "  " + padRight(banner, safeW - 4) + pipe);
  content.push(pipe + "  " + padRight(subtitle, safeW - 4) + pipe);
  content.push(pipe + repeatChar(" ", safeW - 2) + pipe);
  
  for (let i = 0; i < beeLines.length; i++) {
    const r = i === 0 ? "Type /help to explore commands." : i === 1 ? "Run hive providers setup" : "";
    const lPad = padRight(beeLines[i], 12);
    const rPad = r;
    const rawLen = stripAnsi(lPad).length + stripAnsi(rPad).length + 4;
    const rem = safeW - 2 - rawLen;
    content.push(pipe + "  " + lPad + "  " + rPad + repeatChar(" ", Math.max(0, rem)) + pipe);
  }
  
  content.push(pipe + repeatChar(" ", safeW - 2) + pipe);
  const footer2 = `${getVersion()} - ${process.cwd()}`;
  content.push(pipe + "  " + padRight(useColor ? applyColor(footer2, BRAND_COLORS.dim.r, BRAND_COLORS.dim.g, BRAND_COLORS.dim.b) : footer2, safeW - 4) + pipe);
  content.push(pipe + repeatChar(" ", safeW - 2) + pipe);
  
  return [topBorder, ...content, bottomBorder].join("\n");
}

export function renderPlainStartupText(useColor: boolean): string {
  const banner = getHiveTextBanner(useColor);
  const lines = [
    banner,
    "Terminal-native intelligence for verified agentic builds.",
    "",
    "Usage:",
    "  hive run \"<task>\"",
    "  hive providers setup",
    "  hive --help",
    "",
    `${getVersion()} - ${process.cwd()}`
  ];
  return lines.join("\n");
}

export function renderHelpFrame(width: number, useColor: boolean, text: string): string {
  if (width < 70) {
    return text;
  }
  
  const lines = text.split("\n");
  const maxLineW = Math.max(...lines.map(l => stripAnsi(l).length));
  const safeW = Math.max(width, Math.min(100, maxLineW + 4));
  
  const borderH = repeatChar("-", safeW - 2);
  const topBorder = useColor ? gradientText("+" + borderH + "+", TERMINAL_LINE_GRADIENT) : "+" + borderH + "+";
  
  const content = lines.map(l => {
    const pipe = useColor ? gradientText("|", TERMINAL_LINE_GRADIENT) : "|";
    const rem = safeW - 2 - stripAnsi(l).length - 2;
    return pipe + " " + l + repeatChar(" ", Math.max(0, rem)) + " " + pipe;
  });
  
  return [topBorder, ...content, topBorder].join("\n");
}
