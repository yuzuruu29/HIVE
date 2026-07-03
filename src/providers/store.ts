import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ProviderConfig, ProviderRoles } from './types.js';

export class ProviderStore {
  private baseDir: string;
  private providersFile: string;
  private rolesFile: string;

  constructor(repoPath: string) {
    this.baseDir = path.join(repoPath, '.hive');
    this.providersFile = path.join(this.baseDir, 'providers.json');
    this.rolesFile = path.join(this.baseDir, 'provider-roles.json');
  }

  private async ensureDir(): Promise<void> {
    try {
      await fs.access(this.baseDir);
    } catch {
      await fs.mkdir(this.baseDir, { recursive: true });
    }
  }

  public async loadProviders(): Promise<ProviderConfig[]> {
    try {
      const data = await fs.readFile(this.providersFile, 'utf-8');
      return JSON.parse(data) as ProviderConfig[];
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  public async saveProviders(configs: ProviderConfig[]): Promise<void> {
    await this.ensureDir();
    const tmpPath = path.join(this.baseDir, 'providers.tmp.json');
    await fs.writeFile(tmpPath, JSON.stringify(configs, null, 2), 'utf-8');
    await fs.rename(tmpPath, this.providersFile);
  }

  public async loadRoles(): Promise<ProviderRoles> {
    try {
      const data = await fs.readFile(this.rolesFile, 'utf-8');
      return JSON.parse(data) as ProviderRoles;
    } catch (err: any) {
      if (err.code === 'ENOENT') return {};
      throw err;
    }
  }

  public async saveRoles(roles: ProviderRoles): Promise<void> {
    await this.ensureDir();
    const tmpPath = path.join(this.baseDir, 'provider-roles.tmp.json');
    await fs.writeFile(tmpPath, JSON.stringify(roles, null, 2), 'utf-8');
    await fs.rename(tmpPath, this.rolesFile);
  }
}
