import fs from 'fs';
import path from 'path';
import { ScoutFileSignal } from './types.js';
import { isIgnoredPath } from './ignore.js';

const SAFE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.md', '.tsx', '.jsx', '.css', '.html', '.yml', '.yaml', '.sh']);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.exe', '.dll', '.so', '.dylib', '.bin', '.pdf']);

function getLanguage(ext: string): string {
  switch (ext) {
    case '.ts': case '.tsx': return 'TypeScript';
    case '.js': case '.mjs': case '.cjs': case '.jsx': return 'JavaScript';
    case '.json': return 'JSON';
    case '.md': return 'Markdown';
    case '.html': return 'HTML';
    case '.css': return 'CSS';
    case '.yml': case '.yaml': return 'YAML';
    case '.sh': return 'Shell';
    default: return 'Unknown';
  }
}

export async function gatherFileSignals(repoRoot: string): Promise<ScoutFileSignal[]> {
  const signals: ScoutFileSignal[] = [];

  async function walk(dir: string) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(repoRoot, fullPath).replace(/\\/g, '/');

      if (isIgnoredPath(relPath)) continue;

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        
        // Skip binaries and unknown extensions entirely to save time
        if (BINARY_EXTENSIONS.has(ext)) continue;

        let priorityScore = 10;
        let reason = 'General source file';
        let includeExcerpt = false;

        // Boost scores for core config and entry points
        if (entry.name === 'package.json') { priorityScore += 50; reason = 'Project manifest'; }
        else if (entry.name === 'tsconfig.json') { priorityScore += 40; reason = 'TypeScript config'; }
        else if (relPath.startsWith('src/index') || relPath.startsWith('src/main')) { priorityScore += 30; reason = 'Application entry point'; }
        else if (relPath.startsWith('src/cli')) { priorityScore += 30; reason = 'CLI entry point'; }
        else if (relPath.startsWith('src/orchestrator')) { priorityScore += 25; reason = 'Core business logic'; }
        else if (relPath.includes('provider')) { priorityScore += 20; reason = 'Provider integration'; }
        else if (relPath.startsWith('src/ui/')) { priorityScore += 15; reason = 'UI component'; }
        else if (relPath.startsWith('src/tui/')) { priorityScore += 15; reason = 'TUI component'; }
        else if (relPath.startsWith('tests/')) { priorityScore += 15; reason = 'Test suite'; }

        const stat = await fs.promises.stat(fullPath);
        
        const signal: ScoutFileSignal = {
          path: relPath,
          reason,
          size: stat.size,
          language: getLanguage(ext),
          priorityScore
        };

        signals.push(signal);
      }
    }
  }

  await walk(repoRoot);
  return signals;
}
