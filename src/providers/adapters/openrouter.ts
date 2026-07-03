import { ProviderConfig, ProviderHealthResult, ProviderKind } from '../types.js';
import { OpenAiCompatibleAdapter } from './openai-compatible.js';

export class OpenRouterAdapter extends OpenAiCompatibleAdapter {
  kind: ProviderKind = "openrouter";

  protected getHeaders(config: ProviderConfig): Record<string, string> {
    const defaultEnv = config.apiKeyEnv || "OPENROUTER_API_KEY";
    const token = process.env[defaultEnv];
    if (!token) {
      throw new Error(`Missing environment variable ${defaultEnv} for provider ${config.id}.`);
    }
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "HTTP-Referer": "https://github.com/yuzuruu29/HIVE",
      "X-Title": "HIVE CLI"
    };
  }

  async healthCheck(config: ProviderConfig): Promise<ProviderHealthResult> {
    // OpenRouter requires auth context for models if restricted, but standard /models works
    return super.healthCheck({ ...config, baseUrl: config.baseUrl || "https://openrouter.ai/api/v1" });
  }
}
