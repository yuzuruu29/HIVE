export type ProviderKind =
  | "openai"
  | "openai-compatible"
  | "openrouter"
  | "anthropic"
  | "google"
  | "ollama"
  | "local"
  | "oauth"
  | "custom";

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  authType: "api-key" | "bearer" | "oauth" | "none";
  apiKeyEnv?: string;
  tokenEnv?: string;
  model?: string;
  defaultModel?: string;
  approved: boolean;
  supportsStreaming?: boolean;
  supportsToolCalling?: boolean;
  supportsJsonMode?: boolean;
  supportsCodeEditing?: boolean;
  createdAt: string;
  updatedAt: string;
  notes?: string;
}

export interface ProviderHealthResult {
  ok: boolean;
  providerId: string;
  model?: string;
  message: string;
  redactedError?: string;
}

export interface ProviderCompletionInput {
  prompt: string;
  model: string;
  systemPrompt?: string;
}

export interface ProviderCompletionResult {
  output: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** Ephemeral request-only authentication. It must never be placed in ProviderConfig or persisted. */
export interface ProviderRequestCredential { secret: string; kind: "api-key" | "bearer" | "oauth" }

/** Receives partial output as it arrives from a streaming completion. */
export type ProviderChunkHandler = (chunk: string) => void;

export interface ProviderAdapter {
  kind: ProviderKind;
  healthCheck(config: ProviderConfig, credential?: ProviderRequestCredential): Promise<ProviderHealthResult>;
  complete(config: ProviderConfig, input: ProviderCompletionInput, credential?: ProviderRequestCredential): Promise<ProviderCompletionResult>;
  /**
   * Optional streaming variant of `complete`: invokes `onChunk` with partial
   * output as it arrives and resolves with the same final-result shape
   * (accumulated output + usage), so receipts and router fallback stay
   * uniform. Adapters without streaming support are served buffered.
   */
  streamComplete?(config: ProviderConfig, input: ProviderCompletionInput, onChunk: ProviderChunkHandler, credential?: ProviderRequestCredential): Promise<ProviderCompletionResult>;
}

export interface RoleAssignment {
  provider: string;
  model: string;
}

export type ProviderRoles = {
  queen?: RoleAssignment;
  planner?: RoleAssignment;
  scout?: RoleAssignment;
  builder?: RoleAssignment;
  validator?: RoleAssignment;
  reviewer?: RoleAssignment;
  fixer?: RoleAssignment;
  synthesis?: RoleAssignment;
  fallback?: RoleAssignment;
  /** HIVE chatbot / hivebot role assignments (BYOK). */
  planning?: RoleAssignment;
  coding?: RoleAssignment;
  heavyReasoning?: RoleAssignment;
  gameBuilder?: RoleAssignment;
  projectCoworker?: RoleAssignment;
  studyBuddy?: RoleAssignment;
};
