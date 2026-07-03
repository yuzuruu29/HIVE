import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runCoderCli } from '../dist/index.js';
import { CoderOrchestrator } from '../dist/orchestrator.js';
import { TaskStore } from '../dist/store.js';

test('Coder CLI', async (t) => {
  let cwd = path.join(process.cwd(), '.test-cli');
  
  beforeEach(async () => {
    await fs.mkdir(path.join(cwd, '.hivemind', 'coder-tasks'), { recursive: true }).catch(() => {});
    mock.method(CoderOrchestrator.prototype, 'runToReview', async () => ({ state: 'AWAITING_APPROVAL' }));
    mock.method(CoderOrchestrator.prototype, 'push', async () => {});
    mock.method(CoderOrchestrator, 'fromRecord', async (record, cwd, exec) => {
      const orch = new CoderOrchestrator(record.taskId, cwd, [], exec);
      return orch;
    });
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
  });

  await t.test('run command starts task and saves taskId', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const res = await runCoderCli(['run', 'test prompt'], { cwd });
    assert.strictEqual(res.exitCode, 0);
    assert.match(res.output, /Task reached state: AWAITING_APPROVAL/);

    const activeTask = await fs.readFile(path.join(cwd, '.hivemind', 'coder-tasks', 'active-task.txt'), 'utf8');
    assert.match(activeTask, /^cli-\d+$/);
  });

  await t.test('status command uses active task', async () => {
    await fs.writeFile(path.join(cwd, '.hivemind', 'coder-tasks', 'active-task.txt'), 'cli-123', 'utf8');
    const store = new TaskStore(cwd);
    await store.save({ taskId: 'cli-123', state: 'AWAITING_APPROVAL', verificationResults: [], providers: [] });

    const res = await runCoderCli(['status'], { cwd });
    assert.strictEqual(res.exitCode, 0);
    assert.match(res.output, /Cell: cli-123/);
    assert.match(res.output, /Queen: AWAITING_APPROVAL/);
  });

  await t.test('diff command reads local file', async () => {
    await fs.writeFile(path.join(cwd, '.hivemind', 'coder-tasks', 'active-task.txt'), 'cli-123', 'utf8');
    await fs.mkdir(path.join(cwd, '.hivemind', 'coder-tasks', 'cli-123'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.hivemind', 'coder-tasks', 'cli-123', 'diff.patch'), 'test diff content', 'utf8');

    const res = await runCoderCli(['diff', '--full'], { cwd });
    assert.strictEqual(res.exitCode, 0);
    assert.match(res.output, /test diff content/);
  });

  await t.test('push command requires confirmation', async () => {
    await fs.writeFile(path.join(cwd, '.hivemind', 'coder-tasks', 'active-task.txt'), 'cli-123', 'utf8');
    
    const res = await runCoderCli(['push'], { cwd });
    assert.strictEqual(res.exitCode, 1);
    assert.match(res.output, /Must provide --confirmed flag/);
  });

  await t.test('push command calls push API', async () => {
    await fs.writeFile(path.join(cwd, '.hivemind', 'coder-tasks', 'active-task.txt'), 'cli-123', 'utf8');
    const store = new TaskStore(cwd);
    await store.save({ taskId: 'cli-123', state: 'COMPLETED', verificationResults: [], providers: [] });

    process.env.GITHUB_OWNER = 'test';
    process.env.GITHUB_REPO = 'repo';
    process.env.GITHUB_TOKEN = 'secret';

    const res = await runCoderCli(['push', '--confirmed'], { cwd });
    assert.strictEqual(res.exitCode, 0);
    assert.match(res.output, /Task cli-123 pushed to remote/);
  });
});
