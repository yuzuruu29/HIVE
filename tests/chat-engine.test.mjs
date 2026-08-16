import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeChatRole, classifyTask } from '../dist/chat/roles.js';
import { createChatEngine } from '../dist/chat/engine.js';

test('normalizeChatRole accepts kebab-case forms', () => {
  assert.equal(normalizeChatRole('planning'), 'planning');
  assert.equal(normalizeChatRole('heavy-reasoning'), 'heavyReasoning');
  assert.equal(normalizeChatRole('game-builder'), 'gameBuilder');
  assert.equal(normalizeChatRole('project-coworker'), 'projectCoworker');
  assert.equal(normalizeChatRole('study-buddy'), 'studyBuddy');
});

test('normalizeChatRole accepts camelCase forms', () => {
  assert.equal(normalizeChatRole('planning'), 'planning');
  assert.equal(normalizeChatRole('heavyReasoning'), 'heavyReasoning');
  assert.equal(normalizeChatRole('gameBuilder'), 'gameBuilder');
  assert.equal(normalizeChatRole('projectCoworker'), 'projectCoworker');
  assert.equal(normalizeChatRole('studyBuddy'), 'studyBuddy');
});

test('normalizeChatRole is case-insensitive and trims whitespace', () => {
  assert.equal(normalizeChatRole('Heavy-Reasoning'), 'heavyReasoning');
  assert.equal(normalizeChatRole('GAME-BUILDER'), 'gameBuilder');
  assert.equal(normalizeChatRole('  StudyBuddy  '), 'studyBuddy');
  assert.equal(normalizeChatRole('Planning'), 'planning');
});

test('normalizeChatRole returns null for unknown input', () => {
  assert.equal(normalizeChatRole('queen'), null);
  assert.equal(normalizeChatRole('planner'), null);
  assert.equal(normalizeChatRole('not-a-role'), null);
  assert.equal(normalizeChatRole(''), null);
  assert.equal(normalizeChatRole('   '), null);
});

test('classifyTask routes free text to the right persona', () => {
  assert.equal(classifyTask('write a python function to fix the bug'), 'coding');
  assert.equal(classifyTask('help me study this lesson and take a quiz'), 'study-buddy');
  assert.equal(classifyTask('build a godot 3d game level with sprites and physics'), 'game-builder');
  assert.equal(classifyTask('prepare the sprint roadmap and stakeholder status update'), 'project-coworker');
  assert.equal(classifyTask('analyze the trade-offs and prove why the logic holds'), 'heavy-reasoning');
  assert.equal(classifyTask('outline the approach and estimate the scope'), 'planning');
});

function stubRouter(behavior = {}) {
  const calls = { resolve: [], complete: [] };
  const router = {
    async resolve(role, override, signal) {
      calls.resolve.push({ role, override, signal });
      if (behavior.resolveError) throw new Error(behavior.resolveError);
      return behavior.route ?? {
        providerId: 'stub-provider',
        model: 'stub-model',
        source: 'project',
        degraded: false,
      };
    },
    async complete(request) {
      calls.complete.push(request);
      if (behavior.completeError) throw new Error(behavior.completeError);
      return {
        output: `echo: ${request.prompt}`,
        usage: { input: 12, output: 34, total: 46 },
      };
    },
  };
  return { router, calls };
}

test('createChatEngine.complete populates the receipt and passes output through', async () => {
  const { router, calls } = stubRouter();
  const engine = createChatEngine('/tmp/hive-project', 'sess-1', { router });

  const result = await engine.complete({
    role: 'planning',
    prompt: 'hello world',
    systemPrompt: 'be terse',
  });

  assert.equal(result.output, 'echo: hello world');
  assert.equal(result.receipt.role, 'planning');
  assert.equal(result.receipt.providerId, 'stub-provider');
  assert.equal(result.receipt.model, 'stub-model');
  assert.equal(result.receipt.source, 'project');
  assert.equal(result.receipt.degraded, false);
  assert.equal(result.receipt.promptTokens, 12);
  assert.equal(result.receipt.completionTokens, 34);
  assert.equal(result.receipt.totalTokens, 46);
  assert.ok(
    typeof result.receipt.latencyMs === 'number' && result.receipt.latencyMs >= 0,
    'latencyMs must be a non-negative number',
  );

  // The engine resolves first for route metadata, then completes.
  assert.equal(calls.resolve.length, 1);
  assert.equal(calls.resolve[0].role, 'planning');
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.complete[0].prompt, 'hello world');
  assert.equal(calls.complete[0].systemPrompt, 'be terse');
});

test('createChatEngine.complete forwards explicit provider/model as the override', async () => {
  const { router, calls } = stubRouter();
  const engine = createChatEngine('/tmp/hive-project', 'sess-2', { router });

  await engine.complete({
    role: 'coding',
    prompt: 'hi',
    providerId: 'openai-main',
    model: 'gpt-4o',
  });

  assert.deepEqual(calls.resolve[0].override, {
    providerId: 'openai-main',
    model: 'gpt-4o',
  });
  assert.equal(calls.complete[0].providerId, 'openai-main');
  assert.equal(calls.complete[0].model, 'gpt-4o');
});

test('createChatEngine.complete omits the override when no provider/model given', async () => {
  const { router, calls } = stubRouter();
  const engine = createChatEngine('/tmp/hive-project', 'sess-3', { router });

  await engine.complete({ role: 'queen', prompt: 'hi' });

  assert.equal(calls.resolve[0].override, undefined);
});

test('createChatEngine.complete propagates router errors', async () => {
  const { router } = stubRouter({ resolveError: 'no healthy provider' });
  const engine = createChatEngine('/tmp/hive-project', 'sess-4', { router });

  await assert.rejects(
    () => engine.complete({ role: 'planning', prompt: 'hi' }),
    /no healthy provider/,
  );
});

test('createChatEngine.complete reflects degraded fallback routes in the receipt', async () => {
  const { router } = stubRouter({
    route: {
      providerId: 'fallback-provider',
      model: 'fallback-model',
      source: 'fallback',
      degraded: true,
    },
  });
  const engine = createChatEngine('/tmp/hive-project', 'sess-5', { router });

  const result = await engine.complete({ role: 'coding', prompt: 'hi' });

  assert.equal(result.receipt.providerId, 'fallback-provider');
  assert.equal(result.receipt.source, 'fallback');
  assert.equal(result.receipt.degraded, true);
});

test('createChatEngine.resolveRoute exposes route metadata without adapter details', async () => {
  const { router, calls } = stubRouter();
  const engine = createChatEngine('/tmp/hive-project', 'sess-6', { router });

  const route = await engine.resolveRoute('coding', { providerId: 'p1', model: 'm1' });

  assert.deepEqual(route, {
    providerId: 'stub-provider',
    model: 'stub-model',
    source: 'project',
    degraded: false,
  });
  assert.equal(calls.resolve.length, 1);
  assert.deepEqual(calls.resolve[0], {
    role: 'coding',
    override: { providerId: 'p1', model: 'm1' },
    signal: undefined,
  });
});
