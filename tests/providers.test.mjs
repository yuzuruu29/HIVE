import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderRegistry } from '../dist/providers/registry.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('ProviderRegistry lifecycle', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-providers-test-'));
  
  try {
    const registry = new ProviderRegistry(tmpDir);

    await t.test('Initial list is empty', async () => {
      const list = await registry.list();
      assert.equal(list.length, 0);
    });

    await t.test('Add provider without storing raw secret', async () => {
      const config = await registry.add({
        id: 'test-openai',
        name: 'test-openai',
        kind: 'openai',
        authType: 'bearer',
        apiKeyEnv: 'MY_TEST_KEY',
      });

      assert.equal(config.id, 'test-openai');
      assert.equal(config.approved, false);
      
      const fileData = await fs.readFile(path.join(tmpDir, '.hive', 'providers.json'), 'utf-8');
      assert.equal(fileData.includes('MY_TEST_KEY'), true, 'Environment var name is stored');
      assert.equal(fileData.includes('sk-'), false, 'Raw secrets should never be in this file');
    });

    await t.test('Approve provider', async () => {
      await registry.approve('test-openai');
      const p = await registry.get('test-openai');
      assert.equal(p?.approved, true);
    });

    await t.test('Role assignment persists', async () => {
      await registry.setRole('builder', 'test-openai', 'gpt-4o');
      const roles = await registry.getRoles();
      assert.equal(roles.builder?.provider, 'test-openai');
      assert.equal(roles.builder?.model, 'gpt-4o');
    });

    await t.test('Remove provider cascades to roles', async () => {
      await registry.remove('test-openai');
      const list = await registry.list();
      assert.equal(list.length, 0);
      
      const roles = await registry.getRoles();
      assert.equal(roles.builder, undefined);
    });

    await t.test('Ollama config works without API key', async () => {
      await registry.add({
        id: 'local-ollama',
        name: 'local-ollama',
        kind: 'ollama',
        authType: 'none',
        baseUrl: 'http://localhost:11434',
        defaultModel: 'llama3'
      });
      
      const p = await registry.get('local-ollama');
      assert.equal(p?.kind, 'ollama');
      assert.equal(p?.authType, 'none');
    });

    await t.test('Missing environment variable fails safely', async () => {
      await registry.add({
        id: 'missing-env-test',
        name: 'missing-env-test',
        kind: 'openai',
        authType: 'bearer',
        apiKeyEnv: 'NON_EXISTENT_KEY_123',
      });
      delete process.env.NON_EXISTENT_KEY_123;

      const res = await registry.test('missing-env-test');
      assert.equal(res.ok, false);
      assert.match(res.message, /Missing environment variable NON_EXISTENT_KEY_123/);
    });

    await t.test('Mocked health check passes', async (st) => {
      await registry.add({
        id: 'mock-test',
        name: 'mock-test',
        kind: 'openai',
        authType: 'bearer',
        apiKeyEnv: 'MOCK_TEST_KEY',
      });
      process.env.MOCK_TEST_KEY = 'secret-key';

      // Mock global.fetch
      const originalFetch = global.fetch;
      global.fetch = async (url, options) => {
        return {
          ok: true,
          status: 200,
          text: async () => 'mocked',
          json: async () => ({})
        }
      };

      try {
        const res = await registry.test('mock-test');
        assert.equal(res.ok, true);
      } finally {
        global.fetch = originalFetch;
        delete process.env.MOCK_TEST_KEY;
      }
    });

  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
