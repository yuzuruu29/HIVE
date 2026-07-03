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

export interface ProviderAdapter {
  kind: ProviderKind;
  healthCheck(config: ProviderConfig): Promise<ProviderHealthResult>;
  complete(config: ProviderConfig, input: ProviderCompletionInput): Promise<ProviderCompletionResult>;
}

export interface RoleAssignment {
  provider: string;
  model: string;
}

export type ProviderRoles = {
  planner?: RoleAssignment;
  builder?: RoleAssignment;
  validator?: RoleAssignment;
  reviewer?: RoleAssignment;
  synthesis?: RoleAssignment;
  fallback?: RoleAssignment;
};
