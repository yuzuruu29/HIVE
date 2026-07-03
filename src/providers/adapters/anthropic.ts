import { ProviderAdapter, ProviderConfig, ProviderHealthResult, ProviderCompletionInput, ProviderCompletionResult } from '../types.js';

export class AnthropicAdapter implements ProviderAdapter {
  kind = "anthropic" as const;

  async healthCheck(config: ProviderConfig): Promise<ProviderHealthResult> {
    const defaultEnv = config.apiKeyEnv || "ANTHROPIC_API_KEY";
    if (!process.env[defaultEnv]) {
      return { ok: false, providerId: config.id, message: `Missing environment variable ${defaultEnv}`, redactedError: "Missing key" };
    }
    // No dedicated standard /models endpoint in Anthropic currently. Just checking key existence.
    return { ok: true, providerId: config.id, message: "API key is present in environment." };
  }

  async complete(config: ProviderConfig, input: ProviderCompletionInput): Promise<ProviderCompletionResult> {
    const defaultEnv = config.apiKeyEnv || "ANTHROPIC_API_KEY";
    const token = process.env[defaultEnv];
    if (!token) throw new Error(`Missing environment variable ${defaultEnv}`);

    const messages = [{ role: "user", content: input.prompt }];

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": token,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: input.model || config.defaultModel || "claude-3-5-sonnet-20240620",
        max_tokens: 4096,
        system: input.systemPrompt,
        messages
      })
    });

    const data = await res.json() as any;
    if (!res.ok) throw new Error(data.error?.message || `Anthropic error: ${res.status}`);

    return {
      output: data.content[0].text,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens
      } : undefined
    };
  }
}
