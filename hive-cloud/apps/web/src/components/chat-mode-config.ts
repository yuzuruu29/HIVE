import type { ChatMode } from "./chat-interface";

export const chatModeDetails: Record<ChatMode, { title: string; description: string; placeholder: string; suggestions: string[] }> = {
  build: {
    title: "Orchestrate",
    description: "Queen-led specialists plan, build, check, review, and synthesize.",
    placeholder: "Describe the outcome the Council should deliver",
    suggestions: [
      "Review an uploaded TypeScript project",
      "Create a decision-complete implementation plan",
      "Propose and validate a patch for a reported bug",
      "Review a database migration for regressions",
      "Audit an API design and return one verdict",
    ],
  },
  chat: {
    title: "Direct",
    description: "Talk to one selected route when a full Council is unnecessary.",
    placeholder: "Ask a routed model directly",
    suggestions: [
      "Plan my work for this week",
      "Compare two AI models for my project",
      "Rewrite this message professionally",
      "Explain a difficult concept simply",
      "Help me make a decision",
    ],
  },
  research: {
    title: "Research",
    description: "Use the cited search route for source-backed investigation.",
    placeholder: "What should HIVE research with cited sources?",
    suggestions: [
      "Research current tools for an AI application",
      "Compare provider pricing and limits",
      "Summarize a cited technical topic",
      "Investigate alternatives to a framework",
      "Create a source-backed decision brief",
    ],
  },
};
