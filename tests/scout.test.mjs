import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { isIgnoredPath } from '../src/scout/ignore.js';
import { gatherFileSignals } from '../src/scout/file-signals.js';
import { gatherDocSignals } from '../src/scout/doc-signals.js';
import { rankFiles } from '../src/scout/ranking.js';
import { applyBudget } from '../src/scout/budget.js';
import { generateContextPack } from '../src/scout/context-pack.js';

test('Scout Context Engine', async (t) => {
  await t.test('ignore logic filters correctly', () => {
    assert.strictEqual(isIgnoredPath('.git/config'), true);
    assert.strictEqual(isIgnoredPath('node_modules/express/index.js'), true);
    assert.strictEqual(isIgnoredPath('.env.local'), true);
    assert.strictEqual(isIgnoredPath('.env'), true);
    assert.strictEqual(isIgnoredPath('src/index.ts'), false);
    assert.strictEqual(isIgnoredPath('package.json'), false);
    assert.strictEqual(isIgnoredPath('logs/error.log'), true);
    assert.strictEqual(isIgnoredPath('.hivemind/coder-tasks/active-task.txt'), true);
  });

  await t.test('file ranking boosts by path matches', () => {
    const files = [
      { path: 'src/ui/dashboard.ts', reason: '', size: 100, language: 'TypeScript', priorityScore: 15 },
      { path: 'src/cli.ts', reason: '', size: 100, language: 'TypeScript', priorityScore: 30 },
      { path: 'src/orchestrator.ts', reason: '', size: 100, language: 'TypeScript', priorityScore: 25 },
      { path: 'package.json', reason: '', size: 100, language: 'JSON', priorityScore: 60 },
      { path: 'src/providers/adapters/openai.ts', reason: '', size: 100, language: 'TypeScript', priorityScore: 20 }
    ];

    const uiRanked = rankFiles(files, "Fix the dashboard ui");
    assert.strictEqual(uiRanked[0].path, 'src/ui/dashboard.ts'); // boosted by 50 for ui, +25 for dashboard

    const providerRanked = rankFiles(files, "add provider setup api");
    assert.strictEqual(providerRanked[0].path, 'src/providers/adapters/openai.ts'); // boosted for provider
  });

  await t.test('budget correctly truncates large contexts', () => {
    const mockPack = {
      repoRoot: '/fake',
      generatedAt: 'now',
      summary: 'test',
      frameworks: [],
      languages: [],
      scripts: {},
      testHints: [],
      recentChanges: [],
      riskNotes: [],
      importantFiles: [
        { path: 'file1.ts', reason: '', size: 100, language: 'TypeScript', priorityScore: 10 }
      ],
      docs: [
        { path: 'README.md', excerpt: 'A'.repeat(500) },
        { path: 'AGENTS.md', excerpt: 'B'.repeat(500) }
      ]
    };

    // Budget of 600 chars should only fit README and truncate AGENTS
    const budgeted = applyBudget(mockPack, 600);
    assert.strictEqual(budgeted.promptBudget.truncated, true);
    assert.strictEqual(budgeted.docs.length, 1);
    assert.strictEqual(budgeted.docs[0].path, 'README.md');
  });

  await t.test('prompt-size snapshot prevents budget overflow', async () => {
    const { formatScoutText } = await import('../src/scout/format.js');
    
    // Simulate a massive pack to test format boundaries
    const massivePack = {
      repoRoot: '/fake',
      generatedAt: 'now',
      summary: 'Massive summary test',
      frameworks: [],
      languages: [],
      scripts: {},
      testHints: [],
      recentChanges: [],
      riskNotes: ['Risk 1', 'Risk 2'],
      importantFiles: Array.from({length: 100}, (_, i) => ({ 
        path: `src/file${i}.ts`, 
        reason: 'testing', 
        size: 1000, 
        language: 'TypeScript', 
        priorityScore: 10,
        excerpt: 'const a = 1;'
      })),
      docs: Array.from({length: 10}, (_, i) => ({ 
        path: `doc${i}.md`, 
        excerpt: 'B'.repeat(2000) 
      }))
    };

    const budgeted = applyBudget(massivePack, 5000);
    assert.ok(budgeted.promptBudget.truncated, "Massive pack must be truncated");
    
    const formattedText = formatScoutText(budgeted);
    // Header layout adds fixed chars. Ensure we are somewhat near the budget.
    assert.ok(formattedText.length <= 5000 + 2000, "Formatted output should not grossly overflow the raw budget constraint");
  });

  await t.test('context pack generation works on current repo', async () => {
    const root = process.cwd();
    const pack = await generateContextPack(root, "update orchestrator safety");
    
    assert.ok(pack.generatedAt);
    assert.ok(pack.importantFiles.length > 0);
    assert.ok(pack.docs.length >= 0);
    
    // Check ranking worked for orchestrator
    const topFiles = pack.importantFiles.slice(0, 5);
    const hasOrchestrator = topFiles.some(f => f.path.includes('orchestrator.ts'));
    assert.ok(hasOrchestrator, 'orchestrator.ts should be highly ranked for this prompt');
  });
});
