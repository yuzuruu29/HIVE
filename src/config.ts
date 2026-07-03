import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export type HiveMode = 'guarded' | 'standard' | 'autonomous' | 'plan' | 'review';

export interface HiveConfig {
  mode: HiveMode;
}

export class ConfigStore {
  private configPath: string;

  constructor(repoPath: string) {
    this.configPath = path.join(repoPath, '.hive', 'config.json');
  }

  private async ensureDir(): Promise<void> {
    const dir = path.dirname(this.configPath);
    try {
      await fs.access(dir);
    } catch {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  public async load(): Promise<HiveConfig> {
    try {
      const data = await fs.readFile(this.configPath, 'utf-8');
      return JSON.parse(data) as HiveConfig;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        // Default config
        return { mode: 'guarded' };
      }
      throw err;
    }
  }

  public async save(config: HiveConfig): Promise<void> {
    await this.ensureDir();
    const tmpPath = `${this.configPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8');
    await fs.rename(tmpPath, this.configPath);
  }

  public async getMode(): Promise<HiveMode> {
    const config = await this.load();
    return config.mode;
  }

  public async setMode(mode: HiveMode): Promise<void> {
    const config = await this.load();
    config.mode = mode;
    await this.save(config);
  }
}
