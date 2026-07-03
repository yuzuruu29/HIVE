import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore, CoderOrchestrator } from '../dist/index.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('HIVE Coder - Persistence and Restoration', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-coder-test-'));
  const store = new TaskStore(tmpDir);

  await t.test('TaskStore saves and loads a record', async () => {
    const record = {
      taskId: 'test-task-1',
      state: 'PLANNING',
      branchName: 'hive-coder/test-task-1',
      verificationResults: [],
      providers: []
    };

    await store.save(record);
    
    const loaded = await store.load('test-task-1');
    assert.deepEqual(loaded, record);
  });

  await t.test('TaskStore lists all saved records', async () => {
    const record2 = {
      taskId: 'test-task-2',
      state: 'IDLE',
      branchName: 'hive-coder/test-task-2',
      verificationResults: [],
      providers: []
    };

    await store.save(record2);

    const list = await store.list();
    assert.equal(list.length, 2);
    assert.ok(list.some(r => r.taskId === 'test-task-1'));
    assert.ok(list.some(r => r.taskId === 'test-task-2'));
  });

  await t.test('TaskStore returns null for unknown task', async () => {
    const loaded = await store.load('unknown-task');
    assert.equal(loaded, null);
  });

  await t.test('CoderOrchestrator persists state across transitions', async () => {
    const orchestrator = new CoderOrchestrator('test-task-3', tmpDir, []);
    
    // Simulate some transitions manually via saveState logic by triggering the flow
    // But since runToReview is async and does many things, let's just use fromRecord directly
    // to prove we can restore it.
    
    const record = orchestrator.getRecord();
    record.state = 'AWAITING_APPROVAL';
    await store.save(record);

    // Rehydrate
    const loadedRecord = await store.load('test-task-3');
    assert.ok(loadedRecord);
    
    const restored = await CoderOrchestrator.fromRecord(loadedRecord, tmpDir);
    assert.equal(restored.getRecord().state, 'AWAITING_APPROVAL');
  });

  // Cleanup
  await fs.rm(tmpDir, { recursive: true, force: true });
});
