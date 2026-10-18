import fs from "node:fs";
import { BRAND_COLORS, applyColor } from "./colors.js";
import { sanitizeTerminalText, wrapDisplayLine } from "../tui/display-text.js";
import { ASCII_GLYPHS } from "../tui/glyphs.js";
import { padRow, renderHiveMascot, sessionFrameWidth, type Row, type Tone } from "../tui/transcript-view.js";

function getVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
    return `v${pkg.version}`;
  } catch {
    return "v0.x.x";
  }
}

function paint(row: Row, useColor: boolean): string {
  return row.map(({ text, tone }) => {
    if (!useColor || tone === "text") return text;
    const color = tone === "gold" ? { r: 245, g: 197, b: 66 } : BRAND_COLORS.primary_bright;
    return applyColor(text, color.r, color.g, color.b);
  }).join("");
}

function wrapped(text: string, width: number, tone: Tone = "text"): Row[] {
  return sanitizeTerminalText(text).split("\n").flatMap((line) => wrapDisplayLine(line, width, true).map((part): Row => [{ text: part, tone }]));
}

/** The startup and help surfaces share the session's cell-aware framing. */
function frame(body: Row[], width: number, useColor: boolean): string {
  const inner = width - 4;
  const border = [{ text: `+${"-".repeat(width - 2)}+`, tone: "accent" }] satisfies Row;
  return [
    paint(border, useColor),
    ...body.map((row) => paint([{ text: "| ", tone: "accent" }, ...padRow(row, inner), { text: " |", tone: "accent" }], useColor)),
    paint(border, useColor),
  ].join("\n");
}

function startupFrame(width: number, useColor: boolean): string {
  const safeWidth = sessionFrameWidth(width);
  if (safeWidth < 24) return renderPlainStartupText(useColor, safeWidth);
  const inner = safeWidth - 4;
  const withMascot = inner >= 13 + 2 + 24;
  const mascot = withMascot ? renderHiveMascot(ASCII_GLYPHS) : [];
  const textWidth = inner - (withMascot ? 15 : 0);
  const lines: Row[] = [
    ...wrapped("HIVE - Verified Agentic Coding", textWidth, "accent"),
    ...wrapped("Hyper Intelligence for Verified Engineering", textWidth),
    [],
    ...wrapped("Type /help to explore commands.", textWidth),
    ...wrapped("Run hive providers setup to configure models.", textWidth),
    ...wrapped("Run hive providers status to inspect provider health.", textWidth),
    [],
    ...wrapped("Shift+Tab cycles the permission mode.", textWidth),
  ];
  const body = Array.from({ length: Math.max(lines.length, mascot.length) }, (_, index): Row => withMascot
    ? [...(mascot[index] ?? [{ text: " ".repeat(13), tone: "text" }]), { text: "  ", tone: "text" }, ...(lines[index] ?? [])]
    : lines[index] ?? []);
  return frame([
    [], ...body, [],
    ...wrapped(getVersion(), inner),
    ...wrapped(`Workspace: ${sanitizeTerminalText(process.cwd()).replace(/\n/g, " ")}`, inner),
  ], safeWidth, useColor);
}

export function renderStartupFrame(width: number, useColor: boolean): string {
  return startupFrame(width, useColor);
}

export function renderCompactStartupFrame(width: number, useColor: boolean): string {
  return startupFrame(width, useColor);
}

export function renderPlainStartupText(useColor: boolean, width = 80): string {
  const safeWidth = sessionFrameWidth(width);
  return [
    ...wrapped("HIVE - Verified Agentic Coding", safeWidth, "accent"),
    ...wrapped("Hyper Intelligence for Verified Engineering", safeWidth),
    [],
    ...wrapped('hive run "<task>"', safeWidth),
    ...wrapped("hive providers setup", safeWidth),
    ...wrapped("hive --help", safeWidth),
    [],
    ...wrapped(`${getVersion()} - ${sanitizeTerminalText(process.cwd()).replace(/\n/g, " ")}`, safeWidth),
  ].map((row) => paint(row, useColor)).join("\n");
}

export function renderHelpFrame(width: number, useColor: boolean, text: string): string {
  const safeWidth = sessionFrameWidth(width);
  const body = wrapped(text, safeWidth >= 24 ? safeWidth - 4 : safeWidth);
  if (safeWidth < 24) return body.map((row) => paint(row, false)).join("\n");
  return frame(body, safeWidth, useColor);
}
