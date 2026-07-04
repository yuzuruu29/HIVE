import fs from 'fs';
import path from 'path';
import { ScoutContextPack } from './types.js';
import { gatherFileSignals } from './file-signals.js';
import { gatherDocSignals } from './doc-signals.js';
import { rankFiles } from './ranking.js';
import { applyBudget, DEFAULT_MAX_CHARS } from './budget.js';

export async function generateContextPack(repoRoot: string, taskPrompt?: string): Promise<ScoutContextPack> {
  const generatedAt = new Date().toISOString();
  
  // Read basic project info
  let projectName = 'Unknown';
  let scripts: Record<string, string> = {};
  const pkgPath = path.join(repoRoot, 'package.json');
  try {
    const pkgContent = await fs.promises.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgContent);
    projectName = pkg.name || projectName;
    scripts = pkg.scripts || {};
  } catch (e) {
    // Ignore
  }

  // Gather signals
  const allFiles = await gatherFileSignals(repoRoot);
  const docs = await gatherDocSignals(repoRoot);
  
  // Rank files
  const importantFiles = rankFiles(allFiles, taskPrompt);

  const rawPack: Omit<ScoutContextPack, 'promptBudget'> = {
    repoRoot,
    generatedAt,
    summary: `Local repository context gathered by HIVE Scout. Contains file structure, safe doc excerpts, and task-ranked target files.`,
    projectName,
    packageManager: fs.existsSync(path.join(repoRoot, 'package-lock.json')) ? 'npm' : 'unknown',
    frameworks: [],
    languages: Array.from(new Set(allFiles.map(f => f.language))),
    scripts,
    importantFiles,
    docs,
    recentChanges: [], // To be implemented via git integration if needed
    testHints: [],
    riskNotes: [
      'Scout explicitly ignores node_modules, .git, and secret files.',
      'Do not output raw secrets or sensitive data in code generation.'
    ]
  };

  return applyBudget(rawPack, DEFAULT_MAX_CHARS);
}
