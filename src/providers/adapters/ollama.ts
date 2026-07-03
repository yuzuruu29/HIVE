import { ProviderAdapter, ProviderConfig, ProviderHealthResult, ProviderCompletionInput, ProviderCompletionResult } from '../types.js';

export class OllamaAdapter implements ProviderAdapter {
  kind = "ollama" as const;

  async healthCheck(config: ProviderConfig): Promise<ProviderHealthResult> {
    const baseUrl = config.baseUrl || "http://localhost:11434";
    try {
      const res = await fetch(`${baseUrl}/api/tags`, { method: "GET" });
      if (!res.ok) {
        return {
          ok: false,
          providerId: config.id,
          message: `Health check failed: ${res.status}`,
          redactedError: `Status: ${res.status}`
        };
      }
      return { ok: true, providerId: config.id, message: "Health check passed (Ollama is running)." };
    } catch (err: any) {
      return { ok: false, providerId: config.id, message: `Ollama not reachable: ${err.message}`, redactedError: err.message };
    }
  }

  async complete(config: ProviderConfig, input: ProviderCompletionInput): Promise<ProviderCompletionResult> {
    const baseUrl = config.baseUrl || "http://localhost:11434";
    const messages = [];
    if (input.systemPrompt) {
      messages.push({ role: "system", content: input.systemPrompt });
    }
    messages.push({ role: "user", content: input.prompt });

    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model || config.defaultModel,
        messages,
        stream: false
      })
    });

    const data = await res.json() as any;
    if (!res.ok) throw new Error(data.error || `Ollama error: ${res.status}`);

    return {
      output: data.message?.content || "",
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
      }
    };
  }
}
