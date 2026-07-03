import { ProviderAdapter, ProviderConfig, ProviderHealthResult, ProviderCompletionInput, ProviderCompletionResult, ProviderKind } from '../types.js';

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  kind: ProviderKind = "openai-compatible";

  protected getHeaders(config: ProviderConfig): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };

    if (config.authType === "bearer" || config.authType === "api-key") {
      const envKey = config.apiKeyEnv || config.tokenEnv;
      if (!envKey) {
        throw new Error(`Provider ${config.id} is configured with authType ${config.authType} but lacks apiKeyEnv/tokenEnv.`);
      }
      const token = process.env[envKey];
      if (!token) {
        throw new Error(`Missing environment variable ${envKey} for provider ${config.id}.`);
      }
      headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  }

  async healthCheck(config: ProviderConfig): Promise<ProviderHealthResult> {
    try {
      const baseUrl = config.baseUrl || "https://api.openai.com/v1";
      // To test health non-destructively, we list models instead of generating a response if possible,
      // but standard openai endpoint is /models
      const headers = this.getHeaders(config);
      
      const res = await fetch(`${baseUrl}/models`, {
        method: "GET",
        headers
      });

      if (!res.ok) {
        const body = await res.text();
        return {
          ok: false,
          providerId: config.id,
          message: `Health check failed: ${res.status} ${res.statusText}`,
          redactedError: `Status: ${res.status}`
        };
      }

      return {
        ok: true,
        providerId: config.id,
        message: "Health check passed."
      };
    } catch (err: any) {
      return {
        ok: false,
        providerId: config.id,
        message: `Health check failed: ${err.message}`,
        redactedError: err.message
      };
    }
  }

  async complete(config: ProviderConfig, input: ProviderCompletionInput): Promise<ProviderCompletionResult> {
    const baseUrl = config.baseUrl || "https://api.openai.com/v1";
    const headers = this.getHeaders(config);

    const messages = [];
    if (input.systemPrompt) {
      messages.push({ role: "system", content: input.systemPrompt });
    }
    messages.push({ role: "user", content: input.prompt });

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: input.model || config.defaultModel,
        messages
      })
    });

    const data = await res.json() as any;
    if (!res.ok) {
      throw new Error(data.error?.message || `Provider error: ${res.status}`);
    }

    return {
      output: data.choices[0].message.content,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens
      } : undefined
    };
  }
}
