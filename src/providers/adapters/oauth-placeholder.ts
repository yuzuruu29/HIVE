import { ProviderAdapter, ProviderConfig, ProviderHealthResult, ProviderCompletionInput, ProviderCompletionResult } from '../types.js';

export class OAuthPlaceholderAdapter implements ProviderAdapter {
  kind = "oauth" as const;

  async healthCheck(config: ProviderConfig): Promise<ProviderHealthResult> {
    return { 
      ok: false, 
      providerId: config.id, 
      message: "OAuth provider flow is not implemented yet for this provider.", 
      redactedError: "Not implemented" 
    };
  }

  async complete(config: ProviderConfig, input: ProviderCompletionInput): Promise<ProviderCompletionResult> {
    throw new Error("OAuth provider flow is not implemented yet for this provider. API-key or local auth is currently recommended unless this provider adapter explicitly implements OAuth.");
  }
}
