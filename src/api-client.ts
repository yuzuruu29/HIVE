import { CoderAgentExecutor, ProviderRole, ProviderSnapshot } from './types.js';

export class StandaloneExecutor implements CoderAgentExecutor {
  async execute(role: ProviderRole, prompt: string, cwd: string, snapshot: ProviderSnapshot): Promise<{ output: string }> {
    const pType = snapshot.providerType.toLowerCase();
    
    if (pType === 'openai') {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");
      
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: snapshot.modelId || "gpt-4o",
          messages: [{ role: "user", content: prompt }]
        })
      });
      const data = await res.json() as any;
      if (!res.ok) throw new Error(data.error?.message || `OpenAI error: ${res.status}`);
      return { output: data.choices[0].message.content };
    }
    
    if (pType === 'anthropic') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
      
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: snapshot.modelId || "claude-3-opus-20240229",
          max_tokens: 4000,
          messages: [{ role: "user", content: prompt }]
        })
      });
      const data = await res.json() as any;
      if (!res.ok) throw new Error(data.error?.message || `Anthropic error: ${res.status}`);
      return { output: data.content[0].text };
    }
    
    // Minimal fallback for unknown provider
    return { output: `[Simulated response for ${snapshot.providerType} / ${snapshot.modelId}]\nI have executed the prompt.` };
  }
}
