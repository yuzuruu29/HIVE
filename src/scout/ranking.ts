import { ScoutFileSignal } from './types.js';

/**
 * Basic deterministic heuristic to score files based on keywords in the task prompt.
 * We boost files whose paths or names overlap with words in the task.
 */
export function rankFiles(files: ScoutFileSignal[], taskPrompt?: string): ScoutFileSignal[] {
  if (!taskPrompt) {
    // If no task prompt, just sort by priority score descending
    return [...files].sort((a, b) => b.priorityScore - a.priorityScore);
  }

  const promptTokens = taskPrompt.toLowerCase().split(/[\s,.-_]+/).filter(t => t.length > 2);
  
  const scoredFiles = files.map(file => {
    let score = file.priorityScore;
    const pathLower = file.path.toLowerCase();
    
    // Check if prompt words appear in the file path
    for (const token of promptTokens) {
      if (pathLower.includes(token)) {
        score += 25; // Significant boost for keyword match in path
      }
    }

    // Specific domain mapping based on task keywords
    if (promptTokens.includes('provider') && pathLower.includes('provider')) score += 50;
    if (promptTokens.includes('tui') || promptTokens.includes('ui') || promptTokens.includes('pane')) {
      if (pathLower.includes('ui/') || pathLower.includes('tui')) score += 50;
    }
    if (promptTokens.includes('github') || promptTokens.includes('pr')) {
      if (pathLower.includes('forge') || pathLower.includes('orchestrator')) score += 50;
    }
    if (promptTokens.includes('worktree')) {
      if (pathLower.includes('worktree')) score += 50;
    }
    if (promptTokens.includes('safety')) {
      if (pathLower.includes('runner') || pathLower.includes('safety')) score += 50;
    }

    return { file, score };
  });

  return scoredFiles
    .sort((a, b) => b.score - a.score)
    .map(sf => sf.file);
}
