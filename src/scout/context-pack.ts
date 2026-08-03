import fs from 'fs';
import path from 'path';
import { ScoutContextPack } from './types.js';
import { gatherFileSignals } from './file-signals.js';
import { gatherDocSignals } from './doc-signals.js';
import { rankFiles } from './ranking.js';
import { applyBudget, DEFAULT_MAX_CHARS } from './budget.js';

function extractStructuralExcerpt(content: string, taskPrompt?: string, maxLen: number = 400): string {
  if (content.length <= maxLen) return content;
  
  const lines = content.split('\n');
  const excerptLines: string[] = [];
  let currentLen = 0;
  
  const promptTokens = taskPrompt ? taskPrompt.toLowerCase().split(/[\s,.-_]+/).filter(t => t.length > 2) : [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const lower = line.toLowerCase();
    let keep = false;
    
    if (
      line.startsWith('import ') ||
      line.startsWith('export ') ||
      line.includes('function ') ||
      line.includes('class ') ||
      line.includes('interface ') ||
      line.includes('type ')
    ) {
      keep = true;
    } else {
      for (const token of promptTokens) {
        if (lower.includes(token)) {
          keep = true;
          break;
        }
      }
    }
    
    if (keep) {
      if (currentLen + line.length > maxLen) break;
      excerptLines.push(line);
      currentLen += line.length + 1;
    }
  }
  
  if (excerptLines.length === 0) {
    return content.substring(0, maxLen).trim();
  }
  
  return excerptLines.join('\n').trim();
}

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

  // Extract excerpts for top 15 files to provide per-file excerpt quality
  const topFiles = importantFiles.slice(0, 15);
  for (const file of topFiles) {
    try {
      const fullPath = path.join(repoRoot, file.path);
      const content = await fs.promises.readFile(fullPath, 'utf8');
      file.excerpt = extractStructuralExcerpt(content, taskPrompt, 400);
      file.truncated = content.length > 400;
    } catch (e) {
      // Ignore read errors
    }
  }

  // Dynamic risk notes
  const riskNotes = [
    'Scout explicitly ignores node_modules, .git, and secret files.',
    'Do not output raw secrets or sensitive data in code generation.'
  ];
  if (taskPrompt) {
    const pt = taskPrompt.toLowerCase();
    if (pt.includes('tui') || pt.includes('ui')) {
      riskNotes.push('TUI modifications require testing without TTY bounds. Ensure ASCII fallbacks exist.');
    }
    if (pt.includes('provider') || pt.includes('api')) {
      riskNotes.push('Provider changes must not log raw API keys to transcript or stdout.');
    }
    if (pt.includes('git') || pt.includes('worktree')) {
      riskNotes.push('Worktree modifications must maintain strict isolation from the main branch.');
    }
  }

  // Improved context summary
  const summary = `Local repository context gathered by HIVE Scout. Analyzed ${allFiles.length} files.` + 
    (taskPrompt ? ` Dynamically ranked based on task keywords.` : ``);

  const rawPack: Omit<ScoutContextPack, 'promptBudget'> = {
    repoRoot,
    generatedAt,
    summary,
    projectName,
    packageManager: fs.existsSync(path.join(repoRoot, 'package-lock.json')) ? 'npm' : 'unknown',
    frameworks: [],
    languages: Array.from(new Set(allFiles.map(f => f.language))),
    scripts,
    importantFiles,
    docs,
    recentChanges: [], // To be implemented via git integration if needed
    testHints: [],
    riskNotes
  };

  return applyBudget(rawPack, DEFAULT_MAX_CHARS);
}
