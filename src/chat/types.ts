import type { ChatBindingRole } from "../coding/types.js";

export type { ChatBindingRole };

/**
 * Execution metadata attached to an assistant message so the UI can show
 * which provider/model served the turn, whether it fell back, and what it cost.
 */
export interface ChatReceipt {
  role: string;
  providerId: string;
  model: string;
  source?: string;
  degraded?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
  receipt?: ChatReceipt;
}

export type ChatRoleSelection = ChatBindingRole | "auto";

export interface SessionProviderOverride {
  providerId?: string;
  model?: string;
}

export interface ChatSessionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  messages: ChatMessage[];
  role: ChatRoleSelection;
  override?: SessionProviderOverride;
  /** Whether Scout grounding was enabled; the pack itself is rebuilt on resume. */
  grounded?: boolean;
}

// ---------------------------------------------------------------------------
// Desktop-safe DTOs (payload-serializable only — no classes, no node types)
// ---------------------------------------------------------------------------

/** Conversation list entry for the desktop chat rail. */
export interface DesktopChatSummary {
  id: string;
  /** First 80 chars of the first user message, derived service-side. */
  title: string;
  role: string;
  updatedAt: string;
  messageCount: number;
  /** True when the conversation was archived out of the active rail. */
  archived?: boolean;
}

/** One chat message crossing the desktop IPC boundary. */
export interface DesktopChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  at: string;
  receipt?: ChatReceipt;
}

/** Full chat conversation snapshot for the desktop chat surface. */
export interface DesktopChatConversation {
  id: string;
  cwd: string;
  role: string;
  ground: boolean;
  createdAt: string;
  updatedAt: string;
  messages: DesktopChatMessage[];
}
