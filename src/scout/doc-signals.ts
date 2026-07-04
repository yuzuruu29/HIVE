import fs from 'fs';
import path from 'path';
import { ScoutDocSignal } from './types.js';

const IMPORTANT_DOCS = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'SECURITY.md'
];

export async function gatherDocSignals(repoRoot: string): Promise<ScoutDocSignal[]> {
  const signals: ScoutDocSignal[] = [];

  for (const docName of IMPORTANT_DOCS) {
    const fullPath = path.join(repoRoot, docName);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (stat.isFile()) {
        const content = await fs.promises.readFile(fullPath, 'utf8');
        // Cap doc excerpts at 1500 chars to save prompt space
        const maxLength = 1500;
        const truncated = content.length > maxLength;
        const excerpt = truncated ? content.substring(0, maxLength) + '\n... (truncated)' : content;

        signals.push({
          path: docName,
          excerpt,
          truncated
        });
      }
    } catch (e) {
      // File doesn't exist or isn't accessible, just skip
    }
  }

  // Optionally, gather docs/*.md if they exist (up to a small limit)
  const docsDir = path.join(repoRoot, 'docs');
  try {
    const docEntries = await fs.promises.readdir(docsDir, { withFileTypes: true });
    let docsCount = 0;
    for (const entry of docEntries) {
      if (docsCount >= 3) break; // Limit to 3 files from docs/
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const relPath = `docs/${entry.name}`;
        const content = await fs.promises.readFile(path.join(docsDir, entry.name), 'utf8');
        const maxLength = 1000;
        const truncated = content.length > maxLength;
        signals.push({
          path: relPath,
          excerpt: truncated ? content.substring(0, maxLength) + '\n... (truncated)' : content,
          truncated
        });
        docsCount++;
      }
    }
  } catch (e) {
    // docs/ doesn't exist
  }

  return signals;
}
