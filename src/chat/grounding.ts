import { generateContextPack, formatScoutText } from "../scout/index.js";

/**
 * Chat grounding: a bounded Scout context pack prepended to the persona
 * system prompt when the user opts in. Chat budgets are tighter than the
 * coding pipeline's (history alone gets ~48k chars), so the pack is capped
 * below Scout's own 20k default.
 */
export const SCOUT_GROUNDING_MAX_CHARS = 12_000;

/**
 * Builds the Scout grounding block for a chat session. Returns `null` on any
 * failure — grounding must never break a turn.
 */
export async function buildScoutGrounding(
  cwd: string,
  taskPrompt: string,
): Promise<string | null> {
  try {
    const pack = await generateContextPack(cwd, taskPrompt || undefined);
    const text = formatScoutText(pack);
    if (text.length <= SCOUT_GROUNDING_MAX_CHARS) return text;
    return `${text.slice(0, SCOUT_GROUNDING_MAX_CHARS)}\n...[scout context truncated at ${SCOUT_GROUNDING_MAX_CHARS} chars]`;
  } catch {
    return null;
  }
}
