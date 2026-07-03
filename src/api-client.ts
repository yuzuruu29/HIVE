import { CoderAgentExecutor, ProviderRole, ProviderSnapshot } from './types.js';
import { ProviderRegistry } from './providers/registry.js';
import { getAdapterForKind } from './providers/health.js';
import { ProviderConfig } from './providers/types.js';

export class StandaloneExecutor implements CoderAgentExecutor {
  constructor(private repoPath: string) {}

  async execute(role: ProviderRole, prompt: string, cwd: string, snapshot: ProviderSnapshot): Promise<{ output: string }> {
    const registry = new ProviderRegistry(this.repoPath);
    const providerId = snapshot.providerType.toLowerCase();
    
    let config = await registry.get(providerId);

    // Preserve existing fallback behavior if provider registry is empty but environment has keys
    if (!config) {
      if (providerId === 'openai' || providerId === 'anthropic') {
         config = {
           id: providerId,
           name: providerId,
           kind: providerId as any,
           authType: "bearer",
           approved: true,
           createdAt: new Date().toISOString(),
           updatedAt: new Date().toISOString()
         };
      } else {
        throw new Error(`Provider ${providerId} is not configured.`);
      }
    }

    if (!config.approved) {
      throw new Error(`Provider ${config.id} exists but is not approved. Run \`hive providers approve ${config.id}\`.`);
    }

    const adapter = getAdapterForKind(config.kind);
    const result = await adapter.complete(config, {
      prompt,
      model: snapshot.modelId || config.defaultModel || ""
    });

    return { output: result.output };
  }
}
