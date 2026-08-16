import { ProviderAdapter, ProviderConfig, ProviderHealthResult, ProviderCompletionInput, ProviderCompletionResult, ProviderKind, ProviderRequestCredential } from '../types.js';
import { readSseStream } from '../streaming.js';

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  kind: ProviderKind = "openai-compatible";

  protected getHeaders(config: ProviderConfig, credential?: ProviderRequestCredential): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };

    if (config.authType === "bearer" || config.authType === "api-key") {
      const envKey = config.apiKeyEnv || config.tokenEnv;
      if (!envKey && !credential?.secret) {
        throw new Error(`Provider ${config.id} is configured with authType ${config.authType} but lacks apiKeyEnv/tokenEnv.`);
      }
      const token = credential?.secret ?? (envKey ? process.env[envKey] : undefined);
      if (!token) {
        throw new Error(`Missing environment variable ${envKey} for provider ${config.id}.`);
      }
      headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  }

  async healthCheck(config: ProviderConfig, credential?: ProviderRequestCredential): Promise<ProviderHealthResult> {
    try {
      const baseUrl = config.baseUrl || "https://api.openai.com/v1";
      // To test health non-destructively, we list models instead of generating a response if possible,
      // but standard openai endpoint is /models
      const headers = this.getHeaders(config, credential);
      
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

  async complete(config: ProviderConfig, input: ProviderCompletionInput, credential?: ProviderRequestCredential): Promise<ProviderCompletionResult> {
    const baseUrl = config.baseUrl || "https://api.openai.com/v1";
    const headers = this.getHeaders(config, credential);

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

  async streamComplete(config: ProviderConfig, input: ProviderCompletionInput, onChunk: (chunk: string) => void, credential?: ProviderRequestCredential): Promise<ProviderCompletionResult> {
    const baseUrl = config.baseUrl || "https://api.openai.com/v1";
    const headers = this.getHeaders(config, credential);

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
        messages,
        stream: true,
        // OpenAI-family servers attach usage to the final chunk when asked;
        // servers that ignore the field simply omit usage.
        stream_options: { include_usage: true }
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = text;
      try { message = (JSON.parse(text) as any)?.error?.message || text; } catch { /* keep raw text */ }
      throw new Error(message || `Provider error: ${res.status}`);
    }
    if (!res.body) throw new Error("Streaming response has no body.");

    let output = "";
    let usage: ProviderCompletionResult["usage"];
    await readSseStream(res.body, (event) => {
      if (!event.data || event.data === "[DONE]") return;
      let parsed: any;
      try { parsed = JSON.parse(event.data); } catch { return; }
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        output += delta;
        onChunk(delta);
      }
      if (parsed.usage) {
        usage = {
          promptTokens: parsed.usage.prompt_tokens,
          completionTokens: parsed.usage.completion_tokens,
          totalTokens: parsed.usage.total_tokens
        };
      }
    });

    return { output, usage };
  }
}
