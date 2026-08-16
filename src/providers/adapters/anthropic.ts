import { ProviderAdapter, ProviderConfig, ProviderHealthResult, ProviderCompletionInput, ProviderCompletionResult, ProviderRequestCredential } from '../types.js';
import { readSseStream } from '../streaming.js';

export class AnthropicAdapter implements ProviderAdapter {
  kind = "anthropic" as const;

  async healthCheck(config: ProviderConfig, credential?: ProviderRequestCredential): Promise<ProviderHealthResult> {
    const defaultEnv = config.apiKeyEnv || "ANTHROPIC_API_KEY";
    if (!credential?.secret && !process.env[defaultEnv]) {
      return { ok: false, providerId: config.id, message: `Missing environment variable ${defaultEnv}`, redactedError: "Missing key" };
    }
    // No dedicated standard /models endpoint in Anthropic currently. Just checking key existence.
    return { ok: true, providerId: config.id, message: "API key is present in environment." };
  }

  async complete(config: ProviderConfig, input: ProviderCompletionInput, credential?: ProviderRequestCredential): Promise<ProviderCompletionResult> {
    const defaultEnv = config.apiKeyEnv || "ANTHROPIC_API_KEY";
    const token = credential?.secret ?? process.env[defaultEnv];
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

  async streamComplete(config: ProviderConfig, input: ProviderCompletionInput, onChunk: (chunk: string) => void, credential?: ProviderRequestCredential): Promise<ProviderCompletionResult> {
    const defaultEnv = config.apiKeyEnv || "ANTHROPIC_API_KEY";
    const token = credential?.secret ?? process.env[defaultEnv];
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
        messages,
        stream: true
      })
    });

    const data = await res.json() as any;
    if (!res.ok) throw new Error(data.error?.message || `Anthropic error: ${res.status}`);
    if (!res.body) throw new Error("Streaming response has no body.");

    let output = "";
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    await readSseStream(res.body, (event) => {
      if (!event.data || event.data === "[DONE]") return;
      let parsed: any;
      try { parsed = JSON.parse(event.data); } catch { return; }
      if (event.event === "message_start" && parsed.message?.usage?.input_tokens != null) {
        promptTokens = parsed.message.usage.input_tokens;
      }
      if (event.event === "content_block_delta" && parsed.delta?.type === "text_delta" && typeof parsed.delta.text === "string" && parsed.delta.text) {
        output += parsed.delta.text;
        onChunk(parsed.delta.text);
      }
      if (event.event === "message_delta" && parsed.usage?.output_tokens != null) {
        completionTokens = parsed.usage.output_tokens;
      }
    });

    const usage = promptTokens !== undefined || completionTokens !== undefined ? {
      promptTokens: promptTokens ?? 0,
      completionTokens: completionTokens ?? 0,
      totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0)
    } : undefined;
    return { output, usage };
  }
}
