import { getRenderMode, safeWidth } from "./terminal.js";
import { renderStartupFrame, renderCompactStartupFrame, renderPlainStartupText, renderHelpFrame } from "./frame.js";
import { renderStatusRail, StatusRailOptions } from "./status-rail.js";
import { renderHiveCompactHeader } from "./banner.js";
import { gradientText, VIOLET_GRADIENT } from "./colors.js";

export const HIVE_BRAND = "HIVE";
export const HIVE_TAGLINE = "Hyper Intelligence for Verified Engineering";

export function getHiveStartup(): string {
  const mode = getRenderMode();
  const width = safeWidth();
  
  if (mode === 'suppressed') return "";
  
  if (mode === 'full' || (mode === 'nocolor' && width >= 100)) {
    return renderStartupFrame(width, mode === 'full');
  }
  
  if (mode === 'compact' || (mode === 'nocolor' && width >= 70)) {
    return renderCompactStartupFrame(width, mode === 'compact');
  }
  
  return renderPlainStartupText(mode !== 'nocolor' && mode !== 'plain'); // Plain typically means narrow or non-TTY. We can still apply color if it's just narrow TTY, but getRenderMode returns plain if !interactive.
}

export function getHiveHelpHeader(): string {
  const mode = getRenderMode();
  if (mode === 'suppressed') return "";
  return getHiveStartup();
}

export function getHiveProvidersHeader(): string {
  const mode = getRenderMode();
  if (mode === 'suppressed') return "";
  const useColor = mode === 'full' || mode === 'compact';
  return renderHiveCompactHeader({ color: useColor, suffix: "Providers" });
}

export function getHiveRunHeader(options?: StatusRailOptions): string {
  const mode = getRenderMode();
  if (mode === 'suppressed') return "";
  
  const width = safeWidth();
  const useColor = mode === 'full' || mode === 'compact';
  
  if (!options) {
    return renderHiveCompactHeader({ color: useColor, suffix: "Agentic Build" });
  }
  
  return renderStatusRail(width, useColor, options);
}

export function renderHiveWordmark(text: string, options?: { color?: boolean }): string {
  if (options?.color) {
    return gradientText(text, VIOLET_GRADIENT);
  }
  return text;
}
