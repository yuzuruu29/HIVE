import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildScoutGrounding, SCOUT_GROUNDING_MAX_CHARS } from '../dist/chat/grounding.js';
import { parseChatArgs, runChat } from '../dist/chat/chat-cli.js';
import { ChatSessionStore, newChatSessionId } from '../dist/chat/session-store.js';

async function makeRepo(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-grounding-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

test('buildScoutGrounding returns a scout context block for a real repo', async (t) => {
  const repo = await makeRepo({
    'package.json': JSON.stringify({ name: 'grounding-demo', scripts: { build: 'tsc' } }),
    'src/index.ts': 'export function main() { return 1; }\n',
    'README.md': '# grounding demo\nA scout grounding fixture.\n',
  });
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  const text = await buildScoutGrounding(repo, 'explain the build pipeline');
  assert.ok(text, 'expected a grounding block');
  assert.ok(text.includes('HIVE SCOUT CONTEXT'), 'block should carry the scout header');
  assert.ok(text.length <= SCOUT_GROUNDING_MAX_CHARS, 'block must respect the chat budget');
});

test('buildScoutGrounding returns null on failure instead of throwing', async () => {
  const missing = path.join(os.tmpdir(), `hive-grounding-missing-${Date.now()}`);
  assert.equal(await buildScoutGrounding(missing, 'task'), null);
});

test('parseChatArgs recognizes --ground', () => {
  assert.equal(parseChatArgs(['--ground', 'hello']).ground, true);
  assert.equal(parseChatArgs(['hello']).ground, false);
  assert.equal(parseChatArgs(['--json']).ground, false);
});

function stubEngine() {
  const calls = { complete: [] };
  const engine = {
    async complete(request) {
      calls.complete.push(request);
      return {
        output: `echo: ${request.prompt}`,
        receipt: { role: request.role, providerId: 'stub', model: 'stub-model', degraded: false, totalTokens: 10 },
      };
    },
    async resolveRoute() {
      return { providerId: 'stub', model: 'stub-model', source: 'project', degraded: false };
    },
  };
  return { engine, calls };
}

function parseNdjson(output) {
  return output.trim().split('\n').map((line) => JSON.parse(line));
}

test('one-shot --json --ground injects the scout block and emits a grounding event', async (t) => {
  const repo = await makeRepo({
    'package.json': JSON.stringify({ name: 'grounding-oneshot' }),
    'README.md': '# demo\nfixture\n',
  });
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  const { engine, calls } = stubEngine();
  const result = await runChat(['--json', '--ground', 'what is this repo?'], {
    cwd: repo,
    createEngine: () => engine,
  });

  assert.equal(result.exitCode, 0);
  const events = parseNdjson(result.output);
  const grounding = events.find((event) => event.type === 'grounding');
  assert.ok(grounding, 'grounding event must be present');
  assert.equal(grounding.status, 'built');
  assert.ok(grounding.chars > 0);
  assert.ok(
    calls.complete[0].systemPrompt.includes('HIVE SCOUT CONTEXT'),
    'system prompt must carry the scout block',
  );
});

test('one-shot --json without --ground sends the bare persona prompt', async (t) => {
  const repo = await makeRepo({ 'package.json': JSON.stringify({ name: 'grounding-off' }) });
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  const { engine, calls } = stubEngine();
  const result = await runChat(['--json', 'hello'], { cwd: repo, createEngine: () => engine });

  const events = parseNdjson(result.output);
  assert.equal(events.some((event) => event.type === 'grounding'), false);
  assert.equal(calls.complete[0].systemPrompt.includes('HIVE SCOUT CONTEXT'), false);
});

test('one-shot --json --ground survives scout failure with an unavailable event', async () => {
  const missing = path.join(os.tmpdir(), `hive-grounding-missing-${Date.now()}`);
  const { engine, calls } = stubEngine();
  const result = await runChat(['--json', '--ground', 'hello'], {
    cwd: missing,
    createEngine: () => engine,
  });

  assert.equal(result.exitCode, 0);
  const events = parseNdjson(result.output);
  const grounding = events.find((event) => event.type === 'grounding');
  assert.deepEqual(grounding, { type: 'grounding', status: 'unavailable' });
  assert.equal(events.at(-1).type, 'assistant', 'the turn still completes');
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.complete[0].systemPrompt.includes('HIVE SCOUT CONTEXT'), false);
});

test('the grounded flag round-trips through the chat session store', async (t) => {
  const repo = await makeRepo({});
  t.after(() => fs.rm(repo, { recursive: true, force: true }));

  const store = new ChatSessionStore(repo);
  const record = {
    id: newChatSessionId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd: repo,
    messages: [],
    role: 'coding',
    grounded: true,
  };
  await store.save(record);
  const loaded = await store.load(record.id);
  assert.equal(loaded.grounded, true);
});
