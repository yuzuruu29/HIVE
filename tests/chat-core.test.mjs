import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { parseChatArgs, trimHistoryBudget, runChat } from '../dist/chat/chat-cli.js';
import { createReadOnlyToolExecutor } from '../dist/chat/agent-tools.js';

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

test('parseChatArgs recognizes --role, --json, --agent', () => {
  const parsed = parseChatArgs(['--json', '--role', 'coding', '--agent', 'hello']);
  assert.equal(parsed.json, true);
  assert.equal(parsed.agent, true);
  assert.equal(parsed.role, 'coding');
  assert.deepEqual(parsed.positionals, ['hello']);
});

test('parseChatArgs splits --model on the FIRST slash only', () => {
  const parsed = parseChatArgs(['--json', '--model', 'qwen/qwen3-coder', 'hello']);
  assert.equal(parsed.json, true);
  assert.deepEqual(parsed.override, { providerId: 'qwen', model: 'qwen3-coder' });
  assert.deepEqual(parsed.positionals, ['hello']);
});

test('parseChatArgs --model without a slash keeps only a providerId', () => {
  const parsed = parseChatArgs(['--model', 'openai', 'hi']);
  assert.deepEqual(parsed.override, { providerId: 'openai' });
  assert.deepEqual(parsed.positionals, ['hi']);
});

test('parseChatArgs treats flags as value-less and keeps providerId slash intact', () => {
  // A provider id with a slash in the before-first-slash position must survive.
  const parsed = parseChatArgs(['--model', 'qwen/qwen3-coder/big', 'x']);
  assert.deepEqual(parsed.override, { providerId: 'qwen', model: 'qwen3-coder/big' });
});

// ---------------------------------------------------------------------------
// History budget trim
// ---------------------------------------------------------------------------

function msg(content) {
  return { role: 'user', content, at: '' };
}

test('trimHistoryBudget keeps the most recent messages that fit the budget', () => {
  // Each message is 102 chars ("m" + digit + 100 x's). Budget 300 fits the
  // two newest (102 + 102) but not a third (would reach 306).
  const history = Array.from({ length: 5 }, (_, i) => msg(`m${i}${'x'.repeat(100)}`));
  const trimmed = trimHistoryBudget(history, 300);
  assert.equal(trimmed.length, 2);
  assert.ok(trimmed[0].content.startsWith('m3'), 'keeps the newest-fitting messages');
  assert.ok(trimmed[1].content.startsWith('m4'));
  assert.ok(!trimmed.some((m) => m.content.startsWith('m0')));
});

test('trimHistoryBudget always keeps the newest message even if it exceeds budget', () => {
  const history = [msg('y'.repeat(10000)), msg('z')];
  const trimmed = trimHistoryBudget(history, 100);
  assert.equal(trimmed.length, 1);
  assert.equal(trimmed[0].content, 'z');
});

test('trimHistoryBudget returns an empty array for empty history', () => {
  assert.deepEqual(trimHistoryBudget([]), []);
});

// ---------------------------------------------------------------------------
// Read-only agent tools
// ---------------------------------------------------------------------------

const signal = new AbortController().signal;

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hive-chat-tools-'));
}

test('read_file returns the file contents within cwd', async () => {
  const dir = await makeTempDir();
  try {
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello world');
    const exec = createReadOnlyToolExecutor(dir);
    const res = await exec.execute('read_file', { path: 'a.txt' }, {}, signal);
    assert.equal(res.ok, true);
    assert.equal(res.output, 'hello world');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('read_file refuses a relative path escaping the cwd', async () => {
  const dir = await makeTempDir();
  try {
    const exec = createReadOnlyToolExecutor(dir);
    const res = await exec.execute('read_file', { path: '../outside.txt' }, {}, signal);
    assert.equal(res.ok, false);
    assert.match(res.output, /outside/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('read_file refuses an absolute path outside the cwd', async () => {
  const dir = await makeTempDir();
  const outside = await makeTempDir();
  try {
    await fs.writeFile(path.join(outside, 'f.txt'), 'data');
    const exec = createReadOnlyToolExecutor(dir);
    const res = await exec.execute('read_file', { path: path.join(outside, 'f.txt') }, {}, signal);
    assert.equal(res.ok, false);
    assert.match(res.output, /outside/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('read_file refuses deny-listed paths (.git, node_modules, .env, dist)', async () => {
  const dir = await makeTempDir();
  try {
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(path.join(dir, 'node_modules', 'x.js'), 'x');
    await fs.mkdir(path.join(dir, 'dist'));
    await fs.writeFile(path.join(dir, 'dist', 'bundle.js'), 'x');
    await fs.writeFile(path.join(dir, '.env'), 'SECRET=1');

    const exec = createReadOnlyToolExecutor(dir);
    const nodeMod = await exec.execute('read_file', { path: 'node_modules/x.js' }, {}, signal);
    assert.equal(nodeMod.ok, false);
    assert.match(nodeMod.output, /deny-listed/);

    const dist = await exec.execute('read_file', { path: 'dist/bundle.js' }, {}, signal);
    assert.equal(dist.ok, false);

    const env = await exec.execute('read_file', { path: '.env' }, {}, signal);
    assert.equal(env.ok, false);
    assert.match(env.output, /deny-listed/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('list_files lists files recursively and skips deny-listed dirs', async () => {
  const dir = await makeTempDir();
  try {
    await fs.writeFile(path.join(dir, 'a.txt'), 'a');
    await fs.mkdir(path.join(dir, 'sub'));
    await fs.writeFile(path.join(dir, 'sub', 'b.js'), 'b');
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(path.join(dir, 'node_modules', 'c.js'), 'c');

    const exec = createReadOnlyToolExecutor(dir);
    const res = await exec.execute('list_files', {}, {}, signal);
    assert.equal(res.ok, true);
    assert.ok(res.output.includes('a.txt'));
    assert.ok(res.output.includes(`sub${path.sep}b.js`));
    assert.ok(!res.output.includes('node_modules'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('list_files refuses an escaping base path', async () => {
  const dir = await makeTempDir();
  try {
    const exec = createReadOnlyToolExecutor(dir);
    const res = await exec.execute('list_files', { path: '../somewhere' }, {}, signal);
    assert.equal(res.ok, false);
    assert.match(res.output, /outside/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// One-shot --json mode with a stubbed engine seam
// ---------------------------------------------------------------------------

function stubEngine(behavior = {}) {
  const calls = [];
  const engine = {
    async complete(request) {
      calls.push(request);
      const output =
        typeof behavior.output === 'function' ? behavior.output(request) : (behavior.output ?? 'stub reply');
      return {
        output,
        receipt: {
          role: request.role,
          providerId: 'p1',
          model: 'm1',
          source: 'project',
          degraded: false,
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          latencyMs: 1200,
        },
      };
    },
    resolveRoute() {
      return { providerId: 'p1', model: 'm1', source: 'project', degraded: false };
    },
  };
  return { engine, calls };
}

test('runChat --json emits NDJSON user/role/receipt/assistant events', async () => {
  const { engine } = stubEngine();
  const result = await runChat(['--json', 'hello'], {
    cwd: '/tmp/hive-proj',
    createEngine: () => engine,
  });

  assert.equal(result.exitCode, 0);
  const lines = result.output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  assert.equal(lines[0].type, 'user');
  assert.equal(lines[0].content, 'hello');
  assert.equal(lines[1].type, 'role');
  assert.equal(lines[1].source, 'auto');
  assert.equal(lines[2].type, 'receipt');
  assert.equal(lines[2].providerId, 'p1');
  assert.equal(lines[3].type, 'assistant');
  assert.equal(lines[3].content, 'stub reply');
});

test('runChat --json emits manual role source when --role is provided', async () => {
  const { engine } = stubEngine();
  const result = await runChat(['--json', '--role', 'coding', 'hello'], {
    cwd: '/tmp/hive-proj',
    createEngine: () => engine,
  });
  const lines = result.output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(lines[1].type, 'role');
  assert.equal(lines[1].role, 'coding');
  assert.equal(lines[1].source, 'manual');
});

test('runChat --json forwards the --model override to the engine', async () => {
  const { engine, calls } = stubEngine();
  const result = await runChat(['--json', '--model', 'qwen/qwen3-coder', 'hello'], {
    cwd: '/tmp/hive-proj',
    createEngine: () => engine,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(calls[0].providerId, 'qwen');
  assert.equal(calls[0].model, 'qwen3-coder');
});

test('runChat rejects an unknown --role', async () => {
  const { engine } = stubEngine();
  const result = await runChat(['--role', 'banana', 'hello'], {
    cwd: '/tmp/hive-proj',
    createEngine: () => engine,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /banana/);
});

test('runChat --json without a message returns a usage error', async () => {
  const { engine } = stubEngine();
  const result = await runChat(['--json'], {
    cwd: '/tmp/hive-proj',
    createEngine: () => engine,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /message/);
});
