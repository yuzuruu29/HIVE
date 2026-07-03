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

      // Scout: Gather context
      let context = `Project Type: ${pkg.name || 'Unknown'}\n`;
      context += `Scripts: ${result.availableScripts.join(', ')}\n`;
      
      const readmePath = path.join(this.repoPath, 'README.md');
      const readmeStat = await fs.promises.stat(readmePath).catch(() => null);
      if (readmeStat) {
        const readmeContent = await fs.promises.readFile(readmePath, 'utf8');
        context += `\nREADME excerpt:\n${readmeContent.substring(0, 500)}...\n`;
      }

      const agentsPath = path.join(this.repoPath, 'AGENTS.md');
      const agentsStat = await fs.promises.stat(agentsPath).catch(() => null);
      if (agentsStat) {
        const agentsContent = await fs.promises.readFile(agentsPath, 'utf8');
        context += `\nAGENTS.md excerpt:\n${agentsContent.substring(0, 500)}...\n`;
      }

      result.scoutContext = context;
    } catch (err: any) {
      result.isValidRepo = false;
      result.errors = [err.message];
    }

    return result;
  }
}
