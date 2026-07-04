import { ScoutContextPack } from './types.js';

export function formatScoutText(pack: ScoutContextPack): string {
  let text = `=== HIVE SCOUT CONTEXT ===\n`;
  text += `Generated At: ${pack.generatedAt}\n`;
  text += `Project: ${pack.projectName || 'Unknown'} (${pack.packageManager})\n`;
  text += `Summary: ${pack.summary}\n\n`;

  if (pack.riskNotes.length > 0) {
    text += `[RISK NOTES]\n`;
    for (const note of pack.riskNotes) {
      text += `- ${note}\n`;
    }
    text += `\n`;
  }

  if (Object.keys(pack.scripts).length > 0) {
    text += `[SCRIPTS]\n`;
    for (const [name, cmd] of Object.entries(pack.scripts)) {
      text += `- ${name}: ${cmd}\n`;
    }
    text += `\n`;
  }

  if (pack.importantFiles.length > 0) {
    text += `[RANKED TARGET FILES]\n`;
    // Only show top 15 in text summary to keep it tight
    const topFiles = pack.importantFiles.slice(0, 15);
    for (const f of topFiles) {
      text += `- ${f.path} (Score: ${f.priorityScore}, Lang: ${f.language})\n  Reason: ${f.reason}\n`;
      if (f.excerpt) {
        text += `  Excerpt: ${f.excerpt.replace(/\n/g, '\n    ')}\n`;
        if (f.truncated) text += `    ... (truncated)\n`;
      }
    }
    if (pack.importantFiles.length > 15) {
      text += `- ... and ${pack.importantFiles.length - 15} more files\n`;
    }
    text += `\n`;
  }

  if (pack.docs.length > 0) {
    text += `[DOCUMENTATION EXCERPTS]\n`;
    for (const doc of pack.docs) {
      text += `--- ${doc.path} ---\n${doc.excerpt}\n\n`;
    }
  }

  text += `[BUDGET INFO]\nUsed ${pack.promptBudget.usedChars} / ${pack.promptBudget.maxChars} chars${pack.promptBudget.truncated ? ' (TRUNCATED)' : ''}\n`;
  
  return text;
}
