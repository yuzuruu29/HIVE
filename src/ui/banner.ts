import { VIOLET_GRADIENT, gradientText, stripAnsi } from "./colors.js";

export function getWideHiveTitle(color: boolean = true): string[] {
  const lines = [
    "HH   HH  IIIIII  VV    VV  EEEEEEE",
    "HH   HH    II    VV    VV  EE     ",
    "HHHHHHH    II    VV    VV  EEEEE  ",
    "HH   HH    II     VV  VV   EE     ",
    "HH   HH  IIIIII    VVVV    EEEEEEE"
  ];
  if (!color) return lines;
  return lines.map(line => gradientText(line, VIOLET_GRADIENT));
}

export function getLargeHiveTitle(color: boolean = true): string[] {
  const lines = [
    "H   H  III  V   V  EEEEE",
    "H   H   I   V   V  E    ",
    "HHHHH   I   V   V  EEEE ",
    "H   H   I    V V   E    ",
    "H   H  III    V    EEEEE"
  ];
  if (!color) return lines;
  return lines.map(line => gradientText(line, VIOLET_GRADIENT));
}

export function getCompactHiveTitle(color: boolean = true): string[] {
  // Alias for tests/compatibility
  return getLargeHiveTitle(color);
}

export function getLargeHoneycombAscii(color: boolean = true): string[] {
  const lines = [
    "   __    __   ",
    "  /  \\__/  \\  ",
    "  \\__/  \\__/  ",
    "     \\__/     "
  ];
  if (!color) return lines;
  return lines.map(line => gradientText(line, VIOLET_GRADIENT));
}

export function getSmallHoneycombAscii(color: boolean = true): string[] {
  const lines = [
    "  __  __  ",
    " /  \\/  \\ ",
    " \\__/\\__/ ",
    "   \\__/   "
  ];
  if (!color) return lines;
  return lines.map(line => gradientText(line, VIOLET_GRADIENT));
}

export function getQueenBeeAscii(color: boolean = true): string[] {
  const lines = [
    "        /\\_/\\",
    "     __/ o o \\__",
    "   /__   *   __\\",
    "      \\_|||_/",
    "       /_|_\\"
  ];
  if (!color) return lines;
  return lines.map(line => gradientText(line, VIOLET_GRADIENT));
}

export function getCompactQueenBeeAscii(color: boolean = true): string[] {
  const lines = [
    " /\\_/\\ ",
    "/ o o \\",
    "\\_|||_/",
    " /_|_\\ "
  ];
  if (!color) return lines;
  return lines.map(line => gradientText(line, VIOLET_GRADIENT));
}

export function getHiveTextBanner(color: boolean = true): string {
  const text = "HIVE - Verified Agentic Coding";
  if (!color) return text;
  return gradientText(text, VIOLET_GRADIENT);
}

export function renderHiveCompactHeader(options?: { color?: boolean, suffix?: string }): string {
  const useColor = options?.color ?? true;
  const suffix = options?.suffix ? ` - ${options.suffix}` : "";
  const text = `HIVE${suffix} - Verified Agentic Coding`;
  if (!useColor) return text;
  return gradientText(text, VIOLET_GRADIENT);
}
