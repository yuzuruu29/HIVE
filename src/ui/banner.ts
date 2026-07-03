import { renderHiveWordmark } from "./branding.js";
import { supportsColorOutput } from "./terminal.js";

export function renderHiveBanner(options?: { color?: boolean; compact?: boolean; width?: number }): string {
  const useColor = options?.color ?? supportsColorOutput();
  const wordmark = renderHiveWordmark("HIVE", { color: useColor });

  return `
        /\\_/\\
     __/ o o \\__
   /__   *   __\\      ${wordmark}
      \\_|||_/         Hyper Intelligence for Verified Engineering
       /_|_\\
`.replace(/^\n/, ""); // Trim the very first newline but preserve the rest
}

export function renderHiveCompactHeader(options?: { color?: boolean; suffix?: string }): string {
  const useColor = options?.color ?? supportsColorOutput();
  const wordmark = renderHiveWordmark("HIVE", { color: useColor });
  const suffix = options?.suffix ?? "Verified Agentic Coding";

  return `${wordmark} - ${suffix}`;
}
