import { stripAnsi, applyColor, BRAND_COLORS, VIOLET_GRADIENT, gradientText } from "./colors.js";

export interface StatusRailOptions {
  provider?: string;
  model?: string;
  mode?: string;
  agents?: number;
  ctxPercent?: number;
}

export function formatStatusField(label: string, value: string | number, useColor: boolean): string {
  if (value === undefined || value === null) return "";
  const lbl = useColor ? applyColor(label + ":", BRAND_COLORS.muted.r, BRAND_COLORS.muted.g, BRAND_COLORS.muted.b) : label + ":";
  const val = useColor ? applyColor(String(value), BRAND_COLORS.text.r, BRAND_COLORS.text.g, BRAND_COLORS.text.b) : String(value);
  return `${lbl}${val}`;
}

export function renderStatusRail(width: number, useColor: boolean, options: StatusRailOptions): string {
  const fields = [];
  
  if (options.provider) fields.push(formatStatusField("provider", options.provider, useColor));
  if (options.model) fields.push(formatStatusField("model", options.model, useColor));
  if (options.mode) fields.push(formatStatusField("mode", options.mode, useColor));
  if (options.agents) fields.push(formatStatusField("agents", options.agents, useColor));
  if (options.ctxPercent !== undefined) fields.push(formatStatusField("ctx", options.ctxPercent + "%", useColor));
  
  const separator = useColor ? applyColor(" - ", BRAND_COLORS.dim.r, BRAND_COLORS.dim.g, BRAND_COLORS.dim.b) : " - ";
  const leftSide = ["default", ...fields.filter(f => f.length > 0)].join(separator);
  const rightSide = useColor ? applyColor("/ for commands", BRAND_COLORS.muted.r, BRAND_COLORS.muted.g, BRAND_COLORS.muted.b) : "/ for commands";
  
  return truncateStatusRail(leftSide, rightSide, width);
}

export function truncateStatusRail(left: string, right: string, width: number): string {
  const leftLen = stripAnsi(left).length;
  const rightLen = stripAnsi(right).length;
  
  if (leftLen + rightLen + 4 <= width) {
    const spaces = new Array(Math.max(0, width - leftLen - rightLen + 1)).join(" ");
    return left + spaces + right;
  }
  
  // If too long, just return the left side truncated to width
  if (leftLen > width) {
    // Basic truncation logic for ASCII safe width
    let raw = stripAnsi(left);
    if (raw.length > width) {
       return left.substring(0, width - 3) + "..."; // In reality we'd truncate considering ansi, but to be simple and safe we assume it's mostly plain text if it gets this tight, or we just strip formatting.
    }
  }
  
  return left;
}
