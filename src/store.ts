import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { TaskRecord } from './types.js';

export class TaskStore {
  private baseDir: string;

  constructor(repoPath: string) {
    this.baseDir = path.join(repoPath, '.hivemind', 'coder');
  }

  private async ensureDir(): Promise<void> {
    try {
      await fs.access(this.baseDir);
    } catch {
      await fs.mkdir(this.baseDir, { recursive: true });
    }
  }

  public async save(record: TaskRecord): Promise<void> {
    await this.ensureDir();
    const filePath = path.join(this.baseDir, `${record.taskId}.json`);
    const tmpPath = path.join(this.baseDir, `${record.taskId}.tmp.json`);
    await fs.writeFile(tmpPath, JSON.stringify(record, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  public async load(taskId: string): Promise<TaskRecord | null> {
    try {
      const filePath = path.join(this.baseDir, `${taskId}.json`);
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as TaskRecord;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  public async list(): Promise<TaskRecord[]> {
    await this.ensureDir();
    const files = await fs.readdir(this.baseDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    
    const records: TaskRecord[] = [];
    for (const file of jsonFiles) {
      try {
        const data = await fs.readFile(path.join(this.baseDir, file), 'utf-8');
        records.push(JSON.parse(data) as TaskRecord);
      } catch (err) {
        // Skip invalid JSON files
        console.error(`Failed to read task record from ${file}:`, err);
      }
    }
    return records;
  }
}
