import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { runHivebot } from '../dist/chat/hivebot.js';
import {
  COUNCIL_PRESETS,
  loadAgentPrompt,
  loadProtocolDigest,
} from '../dist/chat/skill-protocol.js';

// ---------------------------------------------------------------------------
// Protocol module
// ---------------------------------------------------------------------------

test('COUNCIL_PRESETS aligns rosters with the skill orchestration presets', () => {
  // quick = queen/forger/sentinel, repairRounds 1 (maximum_fix_cycles).
  assert.deepEqual(COUNCIL_PRESETS.quick.agents, ['Queen', 'Forger', 'Sentinel']);
  assert.equal(COUNCIL_PRESETS.quick.repairRounds, 1);
  // standard/deep carry the full six-role council; audit omits the Forger.
  assert.equal(COUNCIL_PRESETS.standard.agents.length, 6);
  assert.equal(COUNCIL_PRESETS.deep.agents.length, 6);
  assert.ok(!COUNCIL_PRESETS.audit.agents.includes('Forger'));
  assert.equal(COUNCIL_PRESETS.audit.repairRounds, 0);
  // Parallelism only when the roster has both Scout + Architect.
  assert.equal(COUNCIL_PRESETS.quick.parallel, false);
  assert.equal(COUNCIL_PRESETS.standard.parallel, true);
  assert.equal(COUNCIL_PRESETS.audit.parallel, true);
});

test('loadAgentPrompt returns a fallback persona when the skill root is missing', async () => {
  const text = await loadAgentPrompt(null, 'Forger');
  assert.match(text, /Forger/);
});

test('loadProtocolDigest stays within the 4000-char bound and is non-empty', async () => {
  const digest = await loadProtocolDigest(null);
  assert.ok(digest.length > 0);
  assert.ok(digest.length <= 4000);
  assert.match(digest, /Sentinel/);
});

// ---------------------------------------------------------------------------
// Scripted stub engine
// ---------------------------------------------------------------------------

/**
 * Scripted engine. Outputs are keyed by the prompting agent (parsed from the
 * prompt's leading `[HIVE] role: <agent>` line) and may be a string, an array
 * consumed per call (for repair/attempt sequencing), or a function.
 */
function makeStub(outputsByAgent, opts = {}) {
  const calls = [];
  const counters = {};
  const engine = {
    async complete(request) {
      calls.push(request);
      const m = String(request.prompt).match(/\[HIVE\] role: (\w+)/);
      const agent = m ? m[1] : null;
      counters[agent] = (counters[agent] ?? 0) + 1;
      const call = counters[agent];
      const script = outputsByAgent[agent];
      let text;
      if (typeof script === 'function') {
        text = script({ request, agent, call });
      } else if (Array.isArray(script)) {
        text = script[Math.min(call - 1, script.length - 1)];
      } else {
        text = script ?? `stub response for ${agent}`;
      }
      const total =
        typeof opts.tokens === 'function' ? opts.tokens({ agent, call }) : (opts.tokens ?? 12);
      return {
        output: text,
        receipt: {
          role: request.role,
          providerId: 'p1',
          model: 'm1',
          source: 'project',
          degraded: false,
          promptTokens: total,
          completionTokens: 0,
          totalTokens: total,
          latencyMs: 5,
        },
      };
    },
    resolveRoute() {
      return { providerId: 'p1', model: 'm1', source: 'project', degraded: false };
    },
  };
  return { engine, calls, counters };
}

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hive-hivebot-'));
}

// ---------------------------------------------------------------------------
// Happy path — COMPLETE + artifacts written
// ---------------------------------------------------------------------------

test('happy path: standard preset runs the full council and writes artifacts', async () => {
  const tmp = await makeTempDir();
  const { engine, calls, counters } = makeStub({
    Queen: 'PRESET: standard\nTask analysis.',
    Scout: 'context map',
    Architect: 'implementation plan',
    Forger: 'patch manifest',
    Sentinel: 'VERDICT: PASS\nall criteria met',
    Scribe: 'final report',
  });
  try {
    const result = await runHivebot('add a new command', {
      cwd: tmp,
      preset: 'standard',
      createEngine: () => engine,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.preset, 'standard');
    assert.equal(result.runId, result.runPath.split(path.sep).slice(-2)[0]);

    // The full six-role roster ran (Scout + Architect = parallel, 8 stage records).
    const agents = result.stages.map((s) => s.agent);
    for (const a of ['Queen', 'Scout', 'Architect', 'Forger', 'Sentinel', 'Scribe']) {
      assert.ok(agents.includes(a), `expected ${a} in stages`);
    }
    assert.ok(result.totalTokens > 0, 'tokens accumulate');

    // run.json mirrors the returned summary.
    const runJson = JSON.parse(await fs.readFile(result.runPath, 'utf-8'));
    assert.equal(runJson.status, 'COMPLETE');
    assert.equal(runJson.preset, 'standard');
    assert.equal(runJson.task, 'add a new command');
    assert.equal(runJson.stages.length, result.stages.length);
    assert.ok(runJson.stages.every((s) => s.receipt && s.receipt.totalTokens !== undefined));

    // report.md exists and is human-readable.
    const report = await fs.readFile(result.reportPath, 'utf-8');
    assert.match(report, /HIVE Run Report/);
    assert.match(report, /Status: COMPLETE/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Queen selects quick via PRESET marker (no caller override)
// ---------------------------------------------------------------------------

test('Queen selects the quick preset via PRESET marker; quick roster runs', async () => {
  const tmp = await makeTempDir();
  const { engine, counters } = makeStub({
    Queen: 'Classify... PRESET: quick',
    Forger: 'patch',
    Sentinel: 'VERDICT: PASS',
  });
  try {
    const result = await runHivebot('fix a typo', {
      cwd: tmp,
      createEngine: () => engine,
    });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.preset, 'quick');
    // quick roster: Queen, Forger, Sentinel — no Scout/Architect/Scribe.
    assert.ok(!result.stages.some((s) => s.agent === 'Scribe'));
    assert.equal(counters.Sentinel, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sentinel FAIL -> PASS repair loop runs exactly once
// ---------------------------------------------------------------------------

test('Sentinel FAIL then PASS triggers exactly one repair round and completes', async () => {
  const tmp = await makeTempDir();
  const { engine, counters } = makeStub({
    Queen: 'PRESET: quick',
    Forger: ['patch v1', 'patch v2'],
    Sentinel: ['VERDICT: FAIL\nissues found', 'VERDICT: PASS\nresolved'],
  });
  try {
    const result = await runHivebot('fix', {
      cwd: tmp,
      preset: 'quick',
      createEngine: () => engine,
    });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.exitCode, 0);
    // Forger + Sentinel each called twice: initial + one repair.
    assert.equal(counters.Forger, 2);
    assert.equal(counters.Sentinel, 2);
    const runJson = JSON.parse(await fs.readFile(result.runPath, 'utf-8'));
    assert.equal(runJson.status, 'COMPLETE');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('Sentinel FAIL findings injected into the repair prompt stay within the bound', async () => {
  const tmp = await makeTempDir();
  const huge = 'VERDICT: FAIL\n' + 'z'.repeat(10_000);
  const { engine, calls } = makeStub({
    Queen: 'PRESET: quick',
    Forger: ['patch v1', 'patch v2'],
    Sentinel: [huge, 'VERDICT: PASS\nok'],
  });
  try {
    const result = await runHivebot('fix', {
      cwd: tmp,
      preset: 'quick',
      createEngine: () => engine,
    });
    assert.equal(result.status, 'COMPLETE');
    const forgerCalls = calls.filter((c) =>
      String(c.prompt).includes('[HIVE] role: Forger'),
    );
    assert.equal(forgerCalls.length, 2, 'initial + one repair Forger call');
    const repairPrompt = String(forgerCalls[1].prompt);
    const start = repairPrompt.indexOf('# Repair directive');
    assert.ok(start >= 0, 'repair directive present in the repair prompt');
    const end = repairPrompt.indexOf('# Prior handoffs');
    const findings = repairPrompt.slice(start, end).trim();
    // The injected findings (boundContext output) is capped at 4000; the raw
    // prompt section adds a couple of join-separator newlines, so allow ~4005.
    assert.ok(
      findings.length <= 4005,
      `repair findings must be bounded to ~4000 chars, got ${findings.length}`,
    );
    assert.ok(
      repairPrompt.lastIndexOf('z'.repeat(4000)) === -1,
      'oversize Sentinel output is truncated in the repair prompt',
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sentinel BLOCKED stops before Scribe
// ---------------------------------------------------------------------------

test('Sentinel BLOCKED halts the run before Scribe', async () => {
  const tmp = await makeTempDir();
  const { engine, counters } = makeStub({
    Queen: 'PRESET: standard',
    Scout: 'map',
    Architect: 'plan',
    Forger: 'patch',
    Sentinel: 'VERDICT: BLOCKED\nmissing credentials',
    Scribe: 'report',
  });
  try {
    const result = await runHivebot('migrate data', {
      cwd: tmp,
      preset: 'standard',
      createEngine: () => engine,
    });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.exitCode, 1);
    assert.ok(!result.stages.some((s) => s.agent === 'Scribe'), 'Scribe must not run');
    assert.equal(counters.Scribe, undefined);
    const runJson = JSON.parse(await fs.readFile(result.runPath, 'utf-8'));
    assert.equal(runJson.status, 'BLOCKED');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Missing verdict marker -> FAIL path
// ---------------------------------------------------------------------------

test('missing VERDICT marker is treated as FAIL and terminates', async () => {
  const tmp = await makeTempDir();
  const { engine } = makeStub({
    Queen: 'PRESET: quick',
    Forger: ['patch v1', 'patch v2'],
    Sentinel: ['no verdict here', 'still no verdict'],
  });
  try {
    const result = await runHivebot('x', {
      cwd: tmp,
      preset: 'quick',
      createEngine: () => engine,
    });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.exitCode, 1);
    assert.match(result.reason, /verdict marker missing/);
    const runJson = JSON.parse(await fs.readFile(result.runPath, 'utf-8'));
    assert.equal(runJson.status, 'FAILED');
    assert.match(runJson.reason, /verdict marker missing/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Token budget exceeded -> BUDGET_EXCEEDED
// ---------------------------------------------------------------------------

test('token budget exceeded stops the run as BUDGET_EXCEEDED', async () => {
  const tmp = await makeTempDir();
  // One huge Queen completion already exceeds the quick tokenBudget.
  const { engine } = makeStub(
    { Queen: 'PRESET: quick' },
    { tokens: 50_000 },
  );
  try {
    const result = await runHivebot('x', {
      cwd: tmp,
      preset: 'quick',
      createEngine: () => engine,
    });
    assert.equal(result.status, 'BUDGET_EXCEEDED');
    assert.equal(result.exitCode, 1);
    assert.match(result.reason, /budget/);
    // Only the Queen stage ran before the budget gate tripped.
    assert.deepEqual(result.stages.map((s) => s.agent), ['Queen']);
    const runJson = JSON.parse(await fs.readFile(result.runPath, 'utf-8'));
    assert.equal(runJson.status, 'BUDGET_EXCEEDED');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Empty task usage error keeps the cli.ts contract
// ---------------------------------------------------------------------------

test('empty task returns a usage error with exitCode 1', async () => {
  const result = await runHivebot('   ', {});
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Usage/);
});
