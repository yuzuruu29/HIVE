import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSseStream, readLineStream } from '../dist/providers/streaming.js';
import { createChatEngine } from '../dist/chat/engine.js';
import { ProviderRouter } from '../dist/coding/provider-router.js';
import { OpenAiCompatibleAdapter } from '../dist/providers/adapters/openai-compatible.js';

function streamOf(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
      } else {
        controller.close();
      }
    },
  });
}

test('readSseStream parses events, joins multi-line data, and ignores comments', async () => {
  const events = [];
  await readSseStream(
    streamOf([
      ': keep-alive\r\n\r\n',
      'event: content_block_delta\r\ndata: {"delta":{"text":"Hel',
      'lo"}}\r\n\r\n',
      'data: [DONE]\n\n',
    ]),
    (event) => events.push(event),
  );

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { event: 'content_block_delta', data: '{"delta":{"text":"Hello"}}' });
  assert.deepEqual(events[1], { event: undefined, data: '[DONE]' });
});

test('readSseStream flushes a trailing event without a blank line', async () => {
  const events = [];
  await readSseStream(streamOf(['data: tail']), (event) => events.push(event));
  assert.deepEqual(events, [{ event: undefined, data: 'tail' }]);
});

test('readLineStream emits each non-empty NDJSON line', async () => {
  const lines = [];
  await readLineStream(
    streamOf(['{"a":1}\n{"b"', ':2}\n', '\n{"c":3}']),
    (line) => lines.push(line),
  );
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

function stubRouter(behavior = {}) {
  const calls = { resolve: [], complete: [], streamComplete: [] };
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
      return { output: `echo: ${request.prompt}`, usage: { input: 12, output: 34, total: 46 } };
    },
  };
  if (behavior.withStreaming) {
    router.streamComplete = async (request, onChunk) => {
      calls.streamComplete.push(request);
      for (const piece of ['Hel', 'lo ', 'world']) onChunk(piece);
      return { output: 'Hello world', usage: { input: 5, output: 7, total: 12 } };
    };
  }
  return { router, calls };
}

test('engine.complete forwards onChunk to the router streaming path', async () => {
  const { router, calls } = stubRouter({ withStreaming: true });
  const engine = createChatEngine('/tmp/hive-project', 'sess-stream-1', { router });

  const chunks = [];
  const result = await engine.complete({
    role: 'planning',
    prompt: 'hi',
    onChunk: (chunk) => chunks.push(chunk),
  });

  assert.equal(result.output, 'Hello world');
  assert.equal(result.receipt.totalTokens, 12);
  assert.deepEqual(chunks, ['Hel', 'lo ', 'world']);
  assert.equal(calls.complete.length, 0);
  assert.equal(calls.streamComplete.length, 1);
  assert.equal(calls.streamComplete[0].prompt, 'hi');
});

test('engine.complete emits one buffered chunk when the router cannot stream', async () => {
  const { router, calls } = stubRouter();
  const engine = createChatEngine('/tmp/hive-project', 'sess-stream-2', { router });

  const chunks = [];
  const result = await engine.complete({
    role: 'coding',
    prompt: 'hi',
    onChunk: (chunk) => chunks.push(chunk),
  });

  assert.equal(result.output, 'echo: hi');
  assert.deepEqual(chunks, ['echo: hi']);
  assert.equal(calls.streamComplete.length, 0);
  assert.equal(calls.complete.length, 1);
});

test('OpenAiCompatibleAdapter.streamComplete accumulates deltas and usage over SSE', async (t) => {
  const originalFetch = globalThis.fetch;
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  globalThis.fetch = async () => new Response(sse, { status: 200 });
  t.after(() => { globalThis.fetch = originalFetch; });

  const adapter = new OpenAiCompatibleAdapter();
  const chunks = [];
  const result = await adapter.streamComplete(
    { id: 'p', name: 'p', kind: 'openai', authType: 'none', approved: true, defaultModel: 'm', createdAt: '', updatedAt: '' },
    { prompt: 'hi', model: 'm' },
    (chunk) => chunks.push(chunk),
  );

  assert.equal(result.output, 'Hello');
  assert.deepEqual(chunks, ['Hel', 'lo']);
  assert.deepEqual(result.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
});

test('OpenAiCompatibleAdapter.streamComplete throws on a non-ok response', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
  t.after(() => { globalThis.fetch = originalFetch; });

  const adapter = new OpenAiCompatibleAdapter();
  await assert.rejects(
    () => adapter.streamComplete(
      { id: 'p', name: 'p', kind: 'openai', authType: 'none', approved: true, defaultModel: 'm', createdAt: '', updatedAt: '' },
      { prompt: 'hi', model: 'm' },
      () => {},
    ),
    /bad key/,
  );
});

// ---- ProviderRouter.streamComplete candidate/fallback semantics ----

function makeRegistry(adapter, config) {
  return {
    async get() { return config; },
    async getRoles() {
      return { planning: { provider: config.id, model: config.defaultModel } };
    },
    async test() { return { ok: true, providerId: config.id, message: 'healthy' }; },
    async getAdapter() { return { adapter, config }; },
  };
}

function baseConfig(overrides = {}) {
  return {
    id: 'p1',
    name: 'p1',
    kind: 'openai-compatible',
    authType: 'none',
    approved: true,
    defaultModel: 'm1',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function newRouter(adapter, config) {
  return new ProviderRouter({
    projectRoot: '/tmp/hive-router-test',
    sessionId: 'sess-router',
    projectRegistry: makeRegistry(adapter, config),
    globalRegistry: { ...makeRegistry(adapter, config), async getRoles() { return {}; } },
  });
}

test('router.streamComplete uses adapter streaming and returns usage', async () => {
  const adapter = {
    kind: 'openai-compatible',
    async healthCheck() { return { ok: true, providerId: 'p1', message: 'ok' }; },
    async complete() { throw new Error('buffered path should not run'); },
    async streamComplete(config, input, onChunk) {
      onChunk('a');
      onChunk('b');
      return { output: 'ab', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } };
    },
  };
  const router = newRouter(adapter, baseConfig());

  const chunks = [];
  const result = await router.streamComplete({ role: 'planning', prompt: 'hi' }, (c) => chunks.push(c));

  assert.deepEqual(chunks, ['a', 'b']);
  assert.equal(result.output, 'ab');
  assert.deepEqual(result.usage, { input: 1, output: 2, total: 3 });
});

test('router.streamComplete falls back to buffered when streaming fails before any chunk', async () => {
  const calls = { complete: 0, streamComplete: 0 };
  const adapter = {
    kind: 'openai-compatible',
    async healthCheck() { return { ok: true, providerId: 'p1', message: 'ok' }; },
    async complete() {
      calls.complete += 1;
      return { output: 'buffered', usage: { promptTokens: 9, completionTokens: 9, totalTokens: 18 } };
    },
    async streamComplete() {
      calls.streamComplete += 1;
      throw new Error('stream unavailable');
    },
  };
  const router = newRouter(adapter, baseConfig());

  const chunks = [];
  const result = await router.streamComplete({ role: 'planning', prompt: 'hi' }, (c) => chunks.push(c));

  assert.equal(calls.streamComplete, 1);
  assert.equal(calls.complete, 1);
  assert.deepEqual(chunks, ['buffered']);
  assert.equal(result.output, 'buffered');
});

test('router.streamComplete does not fall back after chunks were delivered', async () => {
  const calls = { complete: 0 };
  const adapter = {
    kind: 'openai-compatible',
    async healthCheck() { return { ok: true, providerId: 'p1', message: 'ok' }; },
    async complete() {
      calls.complete += 1;
      return { output: 'should not run', usage: undefined };
    },
    async streamComplete(config, input, onChunk) {
      onChunk('partial ');
      throw new Error('mid-stream failure');
    },
  };
  const router = newRouter(adapter, baseConfig());

  const chunks = [];
  await assert.rejects(
    () => router.streamComplete({ role: 'planning', prompt: 'hi' }, (c) => chunks.push(c)),
    /mid-stream failure/,
  );
  assert.deepEqual(chunks, ['partial ']);
  assert.equal(calls.complete, 0);
});

test('router.streamComplete buffers adapters without streaming support', async () => {
  const adapter = {
    kind: 'openai-compatible',
    async healthCheck() { return { ok: true, providerId: 'p1', message: 'ok' }; },
    async complete() {
      return { output: 'whole', usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 } };
    },
  };
  const router = newRouter(adapter, baseConfig());

  const chunks = [];
  const result = await router.streamComplete({ role: 'planning', prompt: 'hi' }, (c) => chunks.push(c));

  assert.deepEqual(chunks, ['whole']);
  assert.equal(result.output, 'whole');
});
