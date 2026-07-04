import { ScoutContextPack, ScoutFileSignal, ScoutDocSignal } from './types.js';

export const DEFAULT_MAX_CHARS = 20000;

export function applyBudget(
  rawPack: Omit<ScoutContextPack, 'promptBudget'>,
  maxChars: number = DEFAULT_MAX_CHARS
): ScoutContextPack {
  let usedChars = 0;
  let truncated = false;

  // Base structures always included (Summary, scripts, risk notes)
  const baseJson = JSON.stringify({
    repoRoot: rawPack.repoRoot,
    generatedAt: rawPack.generatedAt,
    summary: rawPack.summary,
    projectName: rawPack.projectName,
    packageManager: rawPack.packageManager,
    frameworks: rawPack.frameworks,
    languages: rawPack.languages,
    scripts: rawPack.scripts,
    testHints: rawPack.testHints,
    riskNotes: rawPack.riskNotes,
    recentChanges: rawPack.recentChanges
  }, null, 2);

  usedChars += baseJson.length;

  const budgetedDocs: ScoutDocSignal[] = [];
  for (const doc of rawPack.docs) {
    const docSize = doc.path.length + doc.excerpt.length + 50;
    if (usedChars + docSize > maxChars) {
      truncated = true;
      break;
    }
    budgetedDocs.push(doc);
    usedChars += docSize;
  }

  const budgetedFiles: ScoutFileSignal[] = [];
  for (const file of rawPack.importantFiles) {
    // Only include basic metadata in the budget cost, 
    // unless we decide to pull excerpts for important files later
    const fileSizeStr = JSON.stringify(file).length;
    if (usedChars + fileSizeStr > maxChars) {
      truncated = true;
      break; // Stop including more files
    }
    budgetedFiles.push(file);
    usedChars += fileSizeStr;
  }

  return {
    ...rawPack,
    docs: budgetedDocs,
    importantFiles: budgetedFiles,
    promptBudget: {
      maxChars,
      usedChars,
      truncated
    }
  };
}
