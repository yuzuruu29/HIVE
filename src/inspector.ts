import fs from 'fs';
import path from 'path';
import { RepoInspectionResult } from './types.js';

export class RepoInspector {
  constructor(private repoPath: string) {}

  public async inspect(): Promise<RepoInspectionResult> {
    const result: RepoInspectionResult = {
      projectRoot: this.repoPath,
      availableScripts: [],
      isValidRepo: false,
    };

    try {
      const gitPath = path.join(this.repoPath, '.git');
      const gitStat = await fs.promises.stat(gitPath).catch(() => null);
      if (!gitStat) {
        result.errors = ['Not a git repository'];
        return result;
      }

      const pkgPath = path.join(this.repoPath, 'package.json');
      const pkgStat = await fs.promises.stat(pkgPath).catch(() => null);
      if (!pkgStat) {
        result.errors = ['Missing package.json in root'];
        return result;
      }

      result.isValidRepo = true;

      const pkgContent = await fs.promises.readFile(pkgPath, 'utf8');
      const pkg = JSON.parse(pkgContent);
      if (pkg.scripts) {
        result.availableScripts = Object.keys(pkg.scripts);
      }

      // Scout: Gather rich context
      const { generateContextPack, formatScoutText } = await import('./scout/index.js');
      const scoutPack = await generateContextPack(this.repoPath);
      result.scoutContext = formatScoutText(scoutPack);
    } catch (err: any) {
      result.isValidRepo = false;
      result.errors = [err.message];
    }

    return result;
  }
}
