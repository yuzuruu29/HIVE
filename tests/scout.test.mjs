import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { isIgnoredPath } from '../dist/scout/ignore.js';
import { rankFiles } from '../dist/scout/ranking.js';
import { applyBudget } from '../dist/scout/budget.js';
import { generateContextPack } from '../dist/scout/context-pack.js';

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
    const { formatScoutText } = await import('../dist/scout/format.js');
    
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

  await t.test('real-task validation: provider task top 8 contains src/providers', async () => {
    const root = process.cwd();
    const pack = await generateContextPack(root, "Improve provider setup error messages and OpenRouter role assignment docs.");
    const top8 = pack.importantFiles.slice(0, 8);
    const hasProvider = top8.some(f => f.path.startsWith('src/providers/'));
    assert.ok(hasProvider, 'Top 8 must contain src/providers');
  });

  await t.test('real-task validation: TUI task top 8 contains src/ui', async () => {
    const root = process.cwd();
    const pack = await generateContextPack(root, "Fix the TUI diff pane and improve transcript empty states.");
    const top8 = pack.importantFiles.slice(0, 8);
    const hasUI = top8.some(f => f.path.startsWith('src/ui/') || f.path.startsWith('src/tui/'));
    assert.ok(hasUI, 'Top 8 must contain src/ui or src/tui');
  });

  await t.test('real-task validation: worktree task top 8 contains worktree/safety files', async () => {
    const root = process.cwd();
    const pack = await generateContextPack(root, "Strengthen worktree safety checks before commit approval.");
    const top8 = pack.importantFiles.slice(0, 8);
    const hasSafety = top8.some(f => f.path.includes('worktree.ts') || f.path.includes('safety'));
    assert.ok(hasSafety, 'Top 8 must contain worktree or safety files');
  });

  await t.test('real-task validation: GitHub PR task top 8 contains forge/orchestrator files', async () => {
    const root = process.cwd();
    const pack = await generateContextPack(root, "Improve GitHub PR body generation and push confirmation handling.");
    const top8 = pack.importantFiles.slice(0, 8);
    const hasPR = top8.some(f => f.path.includes('forge.ts') || f.path.includes('orchestrator.ts'));
    assert.ok(hasPR, 'Top 8 must contain forge.ts or orchestrator.ts');
  });

  await t.test('real-task validation: Scout task top 8 contains src/scout', async () => {
    const root = process.cwd();
    const pack = await generateContextPack(root, "Improve Scout context ranking and prompt budget behavior.");
    const top8 = pack.importantFiles.slice(0, 8);
    const hasScout = top8.some(f => f.path.startsWith('src/scout/'));
    assert.ok(hasScout, 'Top 8 must contain src/scout');
  });
});
