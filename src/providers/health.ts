import { ProviderConfig, ProviderHealthResult, ProviderKind, ProviderAdapter } from './types.js';
import { OpenAiAdapter } from './adapters/openai.js';
import { OpenAiCompatibleAdapter } from './adapters/openai-compatible.js';
import { OpenRouterAdapter } from './adapters/openrouter.js';
import { OllamaAdapter } from './adapters/ollama.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { GoogleAdapter } from './adapters/google.js';
import { OAuthPlaceholderAdapter } from './adapters/oauth-placeholder.js';
import { CustomAdapter, LocalAdapter } from './adapters/local.js';

export function getAdapterForKind(kind: ProviderKind): ProviderAdapter {
  switch (kind) {
    case "openai": return new OpenAiAdapter();
    case "openai-compatible": return new OpenAiCompatibleAdapter();
    case "openrouter": return new OpenRouterAdapter();
    case "ollama": return new OllamaAdapter();
    case "anthropic": return new AnthropicAdapter();
    case "google": return new GoogleAdapter();
    case "oauth": return new OAuthPlaceholderAdapter();
    case "custom": return new CustomAdapter();
    case "local": return new LocalAdapter();
    default: throw new Error(`Unknown provider kind: ${kind}`);
  }
}

export async function runHealthCheck(config: ProviderConfig): Promise<ProviderHealthResult> {
  const adapter = getAdapterForKind(config.kind);
  return adapter.healthCheck(config);
}
