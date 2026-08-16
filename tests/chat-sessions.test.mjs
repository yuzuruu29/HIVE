import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';

import { ChatSessionStore, ChatSessionCorruptionError, newChatSessionId } from '../dist/chat/session-store.js';
import { compactHistory, totalTokens } from '../dist/chat/history.js';
import { runChat } from '../dist/chat/chat-cli.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hive-chat-sessions-'));
}

function makeRecord(id, { cwd = '/tmp/hive-proj', messages = [], role = 'coding', override } = {}) {
  const now = new Date().toISOString();
  return { id, createdAt: now, updatedAt: now, cwd, messages, role, override };
}

function msg(content, role = 'user') {
  return { role, content, at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Session store: round-trip + corruption guard
// ---------------------------------------------------------------------------

test('newChatSessionId follows the chat-<epoch-ms>-<4hex> format', () => {
  const id = newChatSessionId(1234567890);
  assert.match(id, /^chat-1234567890-[0-9a-f]{4}$/);
  assert.ok(newChatSessionId() !== newChatSessionId(), 'ids differ');
});

test('store round-trip: save → load → list → setActive → getActive → clearActive', async () => {
  const dir = await makeTempDir();
  try {
    const store = new ChatSessionStore(dir);
    const record = makeRecord(newChatSessionId(), {
      messages: [msg('hello'), msg('hi back', 'assistant')],
      role: 'coding',
    });
    await store.save(record);

    const loaded = await store.load(record.id);
    assert.ok(loaded);
    assert.equal(loaded.id, record.id);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[0].content, 'hello');
    assert.equal(loaded.cwd, record.cwd);
    assert.equal(loaded.role, 'coding');

    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, record.id);
    assert.equal(list[0].messageCount, 2);
    assert.equal(list[0].role, 'coding');
    assert.equal(typeof list[0].createdAt, 'string');
    assert.equal(typeof list[0].updatedAt, 'string');

    await store.setActive(record.id);
    const active = await store.getActive();
    assert.ok(active);
    assert.equal(active.id, record.id);
    assert.equal(active.messages.length, 2);

    await store.clearActive();
    assert.equal(await store.getActive(), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('store persists updated messages on a second save', async () => {
  const dir = await makeTempDir();
  try {
    const store = new ChatSessionStore(dir);
    const id = newChatSessionId();
    await store.save(makeRecord(id, { messages: [msg('first')] }));
    const updated = makeRecord(id, { messages: [msg('first'), msg('second', 'assistant')] });
    await store.save(updated);
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('store load returns null for a missing session', async () => {
  const dir = await makeTempDir();
  try {
    const store = new ChatSessionStore(dir);
    assert.equal(await store.load('chat-9999999999-abcd'), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('store corruption guard raises a typed error', async () => {
  const dir = await makeTempDir();
  try {
    const store = new ChatSessionStore(dir);
    const id = 'chat-1000000000-abcd';
    await fs.mkdir(store.baseDirectory, { recursive: true });
    await fs.writeFile(path.join(store.baseDirectory, `${id}.json`), '{ not json', 'utf8');
    await assert.rejects(
      () => store.load(id),
      ChatSessionCorruptionError,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('store corruption guard rejects an invalid role value', async () => {
  const dir = await makeTempDir();
  try {
    const store = new ChatSessionStore(dir);
    const id = 'chat-1000000000-abcd';
    await fs.mkdir(store.baseDirectory, { recursive: true });
    const bad = { id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cwd: '/tmp', messages: [], role: 'sorcerer' };
    await fs.writeFile(path.join(store.baseDirectory, `${id}.json`), JSON.stringify(bad), 'utf8');
    await assert.rejects(() => store.load(id), ChatSessionCorruptionError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('store list skips a corrupt session instead of aborting the listing', async () => {
  const dir = await makeTempDir();
  try {
    const store = new ChatSessionStore(dir);
    const goodId = newChatSessionId();
    await store.save(makeRecord(goodId, { role: 'coding', messages: [msg('hello')] }));

    const corruptId = 'chat-1000000000-dcba';
    await fs.mkdir(store.baseDirectory, { recursive: true });
    await fs.writeFile(path.join(store.baseDirectory, `${corruptId}.json`), '{ not json', 'utf8');
    await assert.rejects(() => store.load(corruptId), ChatSessionCorruptionError);

    const sessions = await store.list();
    assert.deepEqual(
      sessions.map((s) => s.id),
      [goodId],
      'corrupt entry is skipped and the valid session is still listed',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('setActive refuses a session that does not exist', async () => {
  const dir = await makeTempDir();
  try {
    const store = new ChatSessionStore(dir);
    await assert.rejects(() => store.setActive('chat-9999999999-abcd'), /does not exist/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// compactHistory
// ---------------------------------------------------------------------------

test('compactHistory keeps most recent messages that fit the budget', () => {
  const messages = Array.from({ length: 5 }, (_, i) => msg(`m${i}${'x'.repeat(100)}`));
  // 102 chars each; budget 300 fits the newest two (204). Use tokens ≈ ceil /4.
  const result = compactHistory(messages, 300);
  assert.equal(result.kept.length, 2, 'keeps the two newest-fitting');
  assert.ok(result.kept[0].content.startsWith('m3'));
  assert.ok(result.kept[1].content.startsWith('m4'));
  assert.equal(result.dropped, 3);
  assert.equal(result.estimatedTokens, totalTokens(result.kept));
});

test('compactHistory over-budget keeps the newest message', () => {
  const messages = [msg('y'.repeat(10000)), msg('z')];
  const result = compactHistory(messages, 100);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].content, 'z');
  assert.equal(result.dropped, 1);
});

test('compactHistory keeps a single oversized message', () => {
  const big = msg('B'.repeat(5000));
  const result = compactHistory([big], 100);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].content, 'B'.repeat(5000));
  assert.equal(result.dropped, 0);
  assert.equal(result.estimatedTokens, Math.ceil(5000 / 4));
});

test('compactHistory returns empty result for empty input', () => {
  const result = compactHistory([], 100);
  assert.deepEqual(result.kept, []);
  assert.equal(result.dropped, 0);
  assert.equal(result.estimatedTokens, 0);
});

test('totalTokens estimates ceil(chars/4) per message', () => {
  assert.equal(totalTokens([]), 0);
  assert.equal(totalTokens([msg('abcd')]), 1);
  assert.equal(totalTokens([msg('abcde')]), 2);
  assert.equal(totalTokens([msg('aaaa'), msg('bbbb')]), 2);
});

// ---------------------------------------------------------------------------
// Resume flow via the injectable engine seam
// ---------------------------------------------------------------------------

function scriptStubEngine(script) {
  const calls = [];
  const engine = {
    async complete(request) {
      calls.push(request);
      const output = script.shift() ?? 'fallback';
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
          latencyMs: 100,
        },
      };
    },
    resolveRoute() {
      return { providerId: 'p1', model: 'm1', source: 'project', degraded: false };
    },
  };
  return { engine, calls };
}

// Drives the interactive REPL by stubbing process.stdin/stdout (scripted lines,
// prompt capture) and forcing a "TTY" so runChat enters the REPL path. Input is
// fed only once readline actually starts polling (prompt "›" seen), which makes
// the resume path (which awaits a store.load before the first prompt) safe.
async function runInteractive({ cwd, script, resumeSessionId }) {
  const { engine, calls } = scriptStubEngine(script);

  const stdinShim = new PassThrough();
  const stdoutShim = new PassThrough();
  Object.defineProperty(process, 'stdin', { value: stdinShim, configurable: true, writable: true });
  Object.defineProperty(process, 'stdout', { value: stdoutShim, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    const result = runChat([], {
      cwd,
      createEngine: () => engine,
      resumeSessionId,
    });
    await waitForPrompt(stdoutShim);
    for (const line of scriptLengthLines(script.length, '\n')) stdinShim.write(line);
    stdinShim.end();
    const settled = await result;
    return { ...settled, calls };
  } finally {
    Object.defineProperty(process, 'stdin', {
      value: originalStdinRef,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process, 'stdout', {
      value: originalStdoutRef,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', { value: originalTty, configurable: true });
  }
}

const originalStdinRef = process.stdin;
const originalStdoutRef = process.stdout;
const originalTty = process.stdout.isTTY;

// Resolves once readline has written its question prompt, signaling it is now
// actively reading from our stdin shim.
function waitForPrompt(stdoutShim) {
  return new Promise((resolve) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk;
      if (buffer.includes('›')) {
        stdoutShim.off('data', onData);
        resolve();
      }
    };
    stdoutShim.on('data', onData);
  });
}

// Builds `count` chat messages plus a terminal /exit line for the REPL script.
function scriptLengthLines(count, trailing = '\n') {
  const lines = [];
  for (let i = 0; i < count; i += 1) lines.push(`msg${i}${trailing}`);
  lines.push(`/exit${trailing}`);
  return lines;
}

test('runChat persists an interactive session on each completed turn', async () => {
  const dir = await makeTempDir();
  try {
    const store = new ChatSessionStore(dir);
    const { calls } = await runInteractive({ cwd: dir, script: ['first reply'] });
    assert.equal(calls.length, 1, 'one completion ran');
    const sessions = await store.list();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].messageCount, 2, 'user + assistant message persisted');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resumeSessionId restores prior messages into the model context', async () => {
  const dir = await makeTempDir();
  try {
    // Turn 1: create + persist a session with a real message.
    await runInteractive({ cwd: dir, script: ['first reply'] });
    const store = new ChatSessionStore(dir);
    const [session] = await store.list();
    assert.ok(session, 'a session exists after turn 1');

    // Turn 2: resume by id; the engine must see the prior turn in context.
    const { calls } = await runInteractive({
      cwd: dir,
      script: ['second reply'],
      resumeSessionId: session.id,
    });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].prompt.includes('first reply'), 'prior assistant reply restored');
    assert.ok(calls[0].prompt.includes('msg0'), 'current prompt present');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resumeSessionId of an unknown id starts a fresh session', async () => {
  const dir = await makeTempDir();
  try {
    const store = new ChatSessionStore(dir);
    const { calls } = await runInteractive({
      cwd: dir,
      script: ['only reply'],
      resumeSessionId: 'chat-9999999999-abcd',
    });
    assert.equal(calls.length, 1);
    const sessions = await store.list();
    assert.equal(sessions.length, 1, 'new session created');
    assert.notEqual(sessions[0].id, 'chat-9999999999-abcd');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
