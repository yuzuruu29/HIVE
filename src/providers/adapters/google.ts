import { ProviderAdapter, ProviderConfig, ProviderHealthResult, ProviderCompletionInput, ProviderCompletionResult, ProviderRequestCredential } from '../types.js';

export class GoogleAdapter implements ProviderAdapter {
  kind = "google" as const;

  async healthCheck(config: ProviderConfig, credential?: ProviderRequestCredential): Promise<ProviderHealthResult> {
    const defaultEnv = config.apiKeyEnv || "GEMINI_API_KEY";
    if (!credential?.secret && !process.env[defaultEnv] && !process.env["GOOGLE_API_KEY"]) {
      return { ok: false, providerId: config.id, message: `Missing environment variable ${defaultEnv}`, redactedError: "Missing key" };
    }
    return { ok: true, providerId: config.id, message: "API key is present in environment." };
  }

  async complete(config: ProviderConfig, input: ProviderCompletionInput, credential?: ProviderRequestCredential): Promise<ProviderCompletionResult> {
    const defaultEnv = config.apiKeyEnv || "GEMINI_API_KEY";
    const token = credential?.secret ?? process.env[defaultEnv] ?? process.env["GOOGLE_API_KEY"];
    if (!token) throw new Error(`Missing environment variable ${defaultEnv}`);

    const modelId = input.model || config.defaultModel || "gemini-1.5-pro";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${token}`;

    const body: any = {
      contents: [{ role: "user", parts: [{ text: input.prompt }] }]
    };

    if (input.systemPrompt) {
      body.systemInstruction = { parts: [{ text: input.systemPrompt }] };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const data = await res.json() as any;
    if (!res.ok) throw new Error(data.error?.message || `Google error: ${res.status}`);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    
    return {
      output: text,
      usage: data.usageMetadata ? {
        promptTokens: data.usageMetadata.promptTokenCount,
        completionTokens: data.usageMetadata.candidatesTokenCount,
        totalTokens: data.usageMetadata.totalTokenCount
      } : undefined
    };
  }
}
