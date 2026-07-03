import { VIOLET_GRADIENT } from "./colors.js";
import { supportsColorOutput } from "./terminal.js";

export function renderHiveWordmark(text: string = "HIVE", options?: { color?: boolean }): string {
  const useColor = options?.color ?? supportsColorOutput();
  if (!useColor) {
    return text;
  }

  let result = "";
  for (let i = 0; i < text.length; i++) {
    const colorIndex = Math.min(
      Math.floor((i / Math.max(1, text.length - 1)) * (VIOLET_GRADIENT.length - 1)),
      VIOLET_GRADIENT.length - 1
    );
    const { r, g, b } = VIOLET_GRADIENT[colorIndex];
    result += `\x1b[38;2;${r};${g};${b}m${text[i]}`;
  }
  result += "\x1b[0m";
  return result;
}
