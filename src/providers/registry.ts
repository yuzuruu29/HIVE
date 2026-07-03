import { ProviderConfig, ProviderRoles, ProviderKind, ProviderHealthResult, ProviderAdapter } from './types.js';
import { ProviderStore } from './store.js';
import { getAdapterForKind, runHealthCheck } from './health.js';

export class ProviderRegistry {
  private store: ProviderStore;

  constructor(repoPath: string) {
    this.store = new ProviderStore(repoPath);
  }

  async list(): Promise<ProviderConfig[]> {
    return this.store.loadProviders();
  }

  async get(id: string): Promise<ProviderConfig | undefined> {
    const providers = await this.list();
    return providers.find(p => p.id === id);
  }

  async add(config: Omit<ProviderConfig, "createdAt" | "updatedAt" | "approved">): Promise<ProviderConfig> {
    const providers = await this.list();
    if (providers.find(p => p.id === config.id)) {
      throw new Error(`Provider with id ${config.id} already exists.`);
    }

    const newConfig: ProviderConfig = {
      ...config,
      approved: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    providers.push(newConfig);
    await this.store.saveProviders(providers);
    return newConfig;
  }

  async remove(id: string): Promise<boolean> {
    const providers = await this.list();
    const index = providers.findIndex(p => p.id === id);
    if (index === -1) return false;
    
    providers.splice(index, 1);
    await this.store.saveProviders(providers);
    
    const roles = await this.getRoles();
    let rolesChanged = false;
    for (const role of Object.keys(roles) as Array<keyof ProviderRoles>) {
      if (roles[role]?.provider === id) {
        delete roles[role];
        rolesChanged = true;
      }
    }
    if (rolesChanged) await this.store.saveRoles(roles);

    return true;
  }

  async test(id: string): Promise<ProviderHealthResult> {
    const provider = await this.get(id);
    if (!provider) throw new Error(`Provider ${id} not found.`);
    return runHealthCheck(provider);
  }

  async approve(id: string): Promise<void> {
    const providers = await this.list();
    const index = providers.findIndex(p => p.id === id);
    if (index === -1) throw new Error(`Provider ${id} not found.`);

    providers[index].approved = true;
    providers[index].updatedAt = new Date().toISOString();
    await this.store.saveProviders(providers);
  }

  async getRoles(): Promise<ProviderRoles> {
    return this.store.loadRoles();
  }

  async setRole(role: keyof ProviderRoles, providerId: string, model: string): Promise<void> {
    const provider = await this.get(providerId);
    if (!provider) throw new Error(`Provider ${providerId} not found.`);
    if (!provider.approved) throw new Error(`Provider ${providerId} is not approved. Please approve it first.`);

    const roles = await this.getRoles();
    roles[role] = { provider: providerId, model };
    await this.store.saveRoles(roles);
  }

  async getAdapter(id: string): Promise<{ adapter: ProviderAdapter; config: ProviderConfig }> {
    const config = await this.get(id);
    if (!config) throw new Error(`Provider ${id} not found.`);
    if (!config.approved) throw new Error(`Provider ${id} exists but is not approved. Run \`hive providers approve ${id}\`.`);
    
    const adapter = getAdapterForKind(config.kind);
    return { adapter, config };
  }
}
