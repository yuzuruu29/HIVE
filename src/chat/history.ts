import type { ChatMessage } from "./types.js";

/**
 * Rough per-message token estimate: tokens ≈ ceil(chars / 4). No tokenizer is
 * available in this runtime, so this is a stable, deterministic proxy used to
 * budget the history we send to a model.
 */
export function totalTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += Math.ceil(message.content.length / 4);
  }
  return total;
}

export interface CompactHistoryResult {
  /** The most recent messages kept, in original order. Always ≥ 1 when input is non-empty. */
  kept: ChatMessage[];
  /** Number of oldest messages dropped. */
  dropped: number;
  /** Estimated tokens for the kept messages (ceil(chars/4) each). */
  estimatedTokens: number;
}

/**
 * Trims history to the most recent messages whose cumulative content length
 * fits within `charBudget`. The newest message is always kept even if it alone
 * exceeds the budget, and a message is never partially split.
 */
export function compactHistory(
  messages: ChatMessage[],
  charBudget: number,
): CompactHistoryResult {
  const kept: ChatMessage[] = [];
  let totalChars = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const size = messages[i].content.length;
    if (kept.length > 0 && totalChars + size > charBudget) break;
    kept.unshift(messages[i]);
    totalChars += size;
  }
  return { kept, dropped: messages.length - kept.length, estimatedTokens: totalTokens(kept) };
}
