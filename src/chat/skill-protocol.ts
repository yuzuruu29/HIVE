import fs from "node:fs/promises";
import path from "node:path";

/**
 * Protocol data for the Hivebot council engine (`src/chat/hivebot.ts`).
 *
 * This module is derived from the vendored skill reference docs under
 *   skills/hive-mind-council/skills/hive-mind-council/references/
 * (orchestration-presets.md, council-protocol.md, handoff-schema.md,
 * verification-policy.md). It centralizes the preset semantics and the
 * bounded context loading used to assemble per-agent system prompts.
 */

export type HivebotPresetName = "quick" | "standard" | "deep" | "audit";

/**
 * Council orchestration preset. The roster order is the execution order used
 * by the hivebot engine (Queen first; Scout/Architect may run concurrently;
 * Sentinel gates completion; Scribe runs last).
 *
 * Mapping from the skill's `orchestration-presets.md`:
 * - `agents`  ⇐ the `roles` list in that file.
 * - `repairRounds` ⇐ `maximum_fix_cycles` (quick=1, standard=2, deep=2,
 *   audit=0).
 * - `parallel` is a hivebot-engine concern not present in the skill file; we
 *   enable it only when a roster contains *both* Scout and Architect, since
 *   their concerns (context map vs. plan) are independent. audit also maps
 *   both, so it is parallel too.
 * - `maxOutputCharsPerStage` and `tokenBudget` are conservative default budget
 *   knobs. The skill prescribes "context budgeting" qualitatively (council-
 *   protocol.md §7) but gives no numeric values, so these are our choice.
 */
export interface HivebotPreset {
  /** Ordered council roster (agent .md filenames without extension). */
  agents: string[];
  /** Bounded repair cycles available after a Sentinel FAIL. */
  repairRounds: number;
  /** Cap on a single stage's output preserved into handoffs / prompt. */
  maxOutputCharsPerStage: number;
  /** Summed receipt-token budget; exceeding it stops the run. */
  tokenBudget: number;
  /** Run independent stages concurrently (currently Scout + Architect). */
  parallel: boolean;
}

export const COUNCIL_PRESETS: Record<HivebotPresetName, HivebotPreset> = {
  quick: {
    agents: ["Queen", "Forger", "Sentinel"],
    repairRounds: 1,
    maxOutputCharsPerStage: 4_000,
    tokenBudget: 20_000,
    parallel: false,
  },
  standard: {
    agents: ["Queen", "Scout", "Architect", "Forger", "Sentinel", "Scribe"],
    repairRounds: 2,
    maxOutputCharsPerStage: 4_000,
    tokenBudget: 60_000,
    parallel: true,
  },
  deep: {
    agents: ["Queen", "Scout", "Architect", "Forger", "Sentinel", "Scribe"],
    repairRounds: 2,
    maxOutputCharsPerStage: 4_000,
    tokenBudget: 120_000,
    parallel: true,
  },
  audit: {
    agents: ["Queen", "Scout", "Architect", "Sentinel", "Scribe"],
    repairRounds: 0,
    maxOutputCharsPerStage: 4_000,
    tokenBudget: 60_000,
    parallel: true,
  },
};

const REFERENCE_FILES = [
  "orchestration-presets.md",
  "council-protocol.md",
  "handoff-schema.md",
  "verification-policy.md",
];

/** Upper bound for the protocol digest appended to every agent system prompt. */
export const PROTOCOL_DIGEST_MAX_CHARS = 4_000;

/**
 * Reads `agents/<Agent>.md` from the skill root and trims it to `maxChars`
 * (the preset's `maxOutputCharsPerStage`). Returns a short fallback persona
 * when the skill root is unavailable or the file is missing.
 */
export async function loadAgentPrompt(
  skillRoot: string | null,
  agent: string,
  maxChars = 4_000,
): Promise<string> {
  if (!skillRoot) {
    return `${agent} role for the Hive Mind Council.`;
  }
  try {
    const text = await fs.readFile(
      path.join(skillRoot, "agents", `${agent}.md`),
      "utf-8",
    );
    return text.slice(0, maxChars);
  } catch {
    return `${agent} role for the Hive Mind Council.`;
  }
}

/**
 * Extracts a compact line digest from a markdown reference file: heading
 * lines (up to `###`) plus bullet lines. This preserves the headings and key
 * rules without dragging in long prose, tables, or code fences.
 */
function digestReference(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^#{1,3}\s+/.test(line) || /^[-*]\s+\S/.test(line)) {
      lines.push(line);
    }
  }
  return lines;
}

/**
 * Builds a single compact protocol digest (≤ `PROTOCOL_DIGEST_MAX_CHARS`)
 * stitched from the three/four reference files' headings and key rules.
 * It is appended to every agent system prompt so all roles agree on the
 * shared council contract without receiving the full skill corpus.
 */
export async function loadProtocolDigest(
  skillRoot: string | null,
): Promise<string> {
  if (!skillRoot) {
    return (
      "Hive Mind protocol: bounded sequential council with structured " +
      "handoffs; Sentinel gates completion; never loop indefinitely."
    );
  }

  const parts: string[] = [];
  for (const file of REFERENCE_FILES) {
    try {
      const text = await fs.readFile(
        path.join(skillRoot, "references", file),
        "utf-8",
      );
      const heading = file.replace(/\.md$/, "");
      parts.push(`## ${heading}\n${digestReference(text).join("\n")}`);
    } catch {
      // A reference file missing from this build is not fatal; skip it.
    }
  }

  const joined = parts.join("\n\n");
  if (joined.length <= PROTOCOL_DIGEST_MAX_CHARS) return joined;
  return joined.slice(0, PROTOCOL_DIGEST_MAX_CHARS);
}
