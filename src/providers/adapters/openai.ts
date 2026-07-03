import { ProviderConfig, ProviderKind } from '../types.js';
import { OpenAiCompatibleAdapter } from './openai-compatible.js';

export class OpenAiAdapter extends OpenAiCompatibleAdapter {
  kind: ProviderKind = "openai";

  // Defaults to api.openai.com
  protected getHeaders(config: ProviderConfig): Record<string, string> {
    const defaultEnv = config.apiKeyEnv || "OPENAI_API_KEY";
    const token = process.env[defaultEnv];
    if (!token) {
      throw new Error(`Missing environment variable ${defaultEnv} for provider ${config.id}.`);
    }
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    };
  }
}
