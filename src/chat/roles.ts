import type { ProviderRoles } from "../providers/types.js";
import { CHAT_BINDING_ROLES } from "../coding/types.js";
import type { ChatBindingRole } from "./types.js";

/**
 * Chatbot / hivebot role slugs exposed to the user.
 * `auto` is not a stored assignment — it is resolved at runtime by {@link classifyTask}.
 */
export type ChatRoleSlug =
  | "planning"
  | "coding"
  | "heavy-reasoning"
  | "game-builder"
  | "project-coworker"
  | "study-buddy";

export const CHAT_ROLE_SLUGS: readonly ChatRoleSlug[] = [
  "planning",
  "coding",
  "heavy-reasoning",
  "game-builder",
  "project-coworker",
  "study-buddy",
] as const;

/** Maps a user-facing slug to the ProviderRoles key used for BYOK assignment. */
export const ROLE_KEY: Record<ChatRoleSlug, keyof ProviderRoles> = {
  planning: "planning",
  coding: "coding",
  "heavy-reasoning": "heavyReasoning",
  "game-builder": "gameBuilder",
  "project-coworker": "projectCoworker",
  "study-buddy": "studyBuddy",
};

export interface ChatRoleMeta {
  slug: ChatRoleSlug;
  label: string;
  description: string;
  /** Default model family suggestion shown during setup (not required). */
  suggestedModel: string;
  /** Persona system prompt used when this role answers in chat. */
  systemPrompt: string;
  /** Keywords used by the `auto` classifier. */
  keywords: string[];
}

export const CHAT_ROLE_META: Record<ChatRoleSlug, ChatRoleMeta> = {
  planning: {
    slug: "planning",
    label: "Planning",
    description: "Breaks work into scoped, sequenced plans and architecture.",
    suggestedModel: "gpt-4o",
    systemPrompt:
      "You are HIVE Planning — a meticulous technical planner. Decompose the user's goal into a clear, sequenced plan with concrete steps, risk notes, and measurable acceptance criteria. Prefer structured outlines. Ask clarifying questions only when the goal is genuinely ambiguous.",
    keywords: ["plan", "design", "architect", "scope", "estimate", "break down", "approach", "strategy", "roadmap", "outline"],
  },
  coding: {
    slug: "coding",
    label: "Coding",
    description: "Implements, refactors, debugs, and explains code.",
    suggestedModel: "gpt-4o",
    systemPrompt:
      "You are HIVE Coding — an expert software engineer. Write correct, idiomatic, well-structured code. When fixing bugs, explain the root cause. Keep answers practical and include runnable snippets when relevant.",
    keywords: ["code", "implement", "bug", "function", "refactor", "write", "fix", "debug", "test", "build", "api", "class", "script", "compile", "typescript", "python"],
  },
  "heavy-reasoning": {
    slug: "heavy-reasoning",
    label: "Heavy Reasoning",
    description: "Handles deep analysis, proofs, trade-offs, and research.",
    suggestedModel: "o1",
    systemPrompt:
      "You are HIVE Heavy Reasoning — a rigorous analytical thinker. Work through problems step by step, weigh trade-offs, consider edge cases, and justify conclusions with explicit reasoning. Do not rush to an answer.",
    keywords: ["analyze", "reason", "logic", "proof", "complex", "deep", "evaluate", "research", "trade-off", "decision", "why", "derive", "prove"],
  },
  "game-builder": {
    slug: "game-builder",
    label: "Game Builder",
    description: "Designs and builds game systems, levels, sprites, and mechanics.",
    suggestedModel: "gpt-4o",
    systemPrompt:
      "You are HIVE Game Builder — a game development specialist. Help with game design, mechanics, level layouts, gameplay loops, 2D/3D systems, sprites, shaders, physics, and engine-specific code (Godot, Unity, Unreal, Phaser). Favor playable, fun-first solutions.",
    keywords: ["game", "godot", "unity", "unreal", "phaser", "2d", "3d", "sprite", "physics", "level", "gameplay", "mesh", "shader", "tilemap", "mechanic"],
  },
  "project-coworker": {
    slug: "project-coworker",
    label: "Project Co-worker",
    description: "Coordinates delivery: roadmaps, sprints, status, and comms.",
    suggestedModel: "gpt-4o-mini",
    systemPrompt:
      "You are HIVE Project Co-worker — a reliable delivery partner. Help plan roadmaps, structure sprints and milestones, draft status updates, surface risks and dependencies, and keep stakeholders aligned. Be concise and action-oriented.",
    keywords: ["project", "roadmap", "sprint", "milestone", "coordinate", "manage", "schedule", "stakeholder", "timeline", "status", "delivery", "standup", "retro"],
  },
  "study-buddy": {
    slug: "study-buddy",
    label: "Study Buddy",
    description: "Teaches concepts, makes notes, and quizzes for learning.",
    suggestedModel: "gpt-4o-mini",
    systemPrompt:
      "You are HIVE Study Buddy — a patient tutor. Explain concepts clearly with examples and analogies suited to the learner's level. Offer mnemonics, summaries, and short quizzes. Encourage understanding over memorization.",
    keywords: ["learn", "study", "explain", "tutorial", "course", "concept", "understand", "what is", "why does", "teach", "quiz", "notes", "summary", "lesson"],
  },
};

const CLASSIFY_ORDER: ChatRoleSlug[] = [
  "game-builder",
  "study-buddy",
  "project-coworker",
  "heavy-reasoning",
  "planning",
  "coding",
];

/**
 * Classifies a free-text task into a chat role. Used by the `auto` assignment
 * mode to pick the right model/persona without the user specifying a role.
 */
export function classifyTask(text: string): ChatRoleSlug {
  const lower = ` ${text.toLowerCase()} `;
  let best: ChatRoleSlug = "coding";
  let bestScore = 0;
  for (const slug of CLASSIFY_ORDER) {
    const score = CHAT_ROLE_META[slug].keywords.reduce(
      (acc, kw) => (lower.includes(kw) ? acc + 1 : acc),
      0,
    );
    if (score > bestScore) {
      bestScore = score;
      best = slug;
    }
  }
  return best;
}

function kebabCase(role: ChatBindingRole): string {
  return role.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Normalizes a user-supplied role name (kebab-case or camelCase,
 * case-insensitive) to a {@link ChatBindingRole}. Returns `null` for unknown
 * input so callers can surface a validation error instead of guessing.
 */
export function normalizeChatRole(input: string): ChatBindingRole | null {
  const key = input.trim().toLowerCase();
  if (!key) return null;
  for (const role of CHAT_BINDING_ROLES) {
    if (key === role.toLowerCase() || key === kebabCase(role)) return role;
  }
  return null;
}

/** Desktop-safe persona card copy (labels + descriptions, no prompts). */
export interface ChatRoleCard {
  slug: ChatRoleSlug;
  label: string;
  description: string;
}

export const CHAT_ROLE_CARDS: readonly ChatRoleCard[] = CHAT_ROLE_SLUGS.map((slug) => ({
  slug,
  label: CHAT_ROLE_META[slug].label,
  description: CHAT_ROLE_META[slug].description,
}));
