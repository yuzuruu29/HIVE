#!/usr/bin/env node

/**
 * semantic-rules.test.js — Focused tests for each semantic rule
 *
 * Directly tests the validateSemantics() function from tools/semantic-rules.js.
 * Each rule is tested with a passing case and a failing case.
 *
 * Usage:
 *   node tests/semantic/semantic-rules.test.js
 *
 * Exit code:
 *   0  — all tests pass
 *   1  — one or more tests fail
 */

'use strict';

const { validateSemantics } = require('../../tools/semantic-rules');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function reportPass(label) {
  console.log(`  PASS: ${label}`);
  passed++;
}

function reportFail(label, detail) {
  console.log(`  FAIL: ${label} — ${detail}`);
  failed++;
  failures.push({ label, detail });
}

function assertNoErrors(ruleName, errors) {
  if (errors.length === 0) {
    reportPass(ruleName);
  } else {
    reportFail(ruleName, `Expected no errors but got: ${errors.map(e => `[${e.rule}] ${e.message}`).join('; ')}`);
  }
}

function assertHasError(ruleName, errors, expectedRule) {
  const matching = errors.filter(e => e.rule === expectedRule);
  if (matching.length > 0) {
    reportPass(ruleName);
  } else {
    const allRules = errors.map(e => e.rule).join(', ');
    reportFail(ruleName, `Expected error with rule "${expectedRule}" but got: ${allRules || 'no errors'}`);
  }
}

// ---------------------------------------------------------------------------
// Rule 1: audit-no-source-edits
// ---------------------------------------------------------------------------

function testAuditNoSourceEdits() {
  console.log('\n[Rule 1: audit-no-source-edits]');

  // Passing: audit mode with empty files_affected
  const passData = {
    execution_mode: 'audit',
    files_affected: [],
  };
  const passErrors = validateSemantics('final-review', passData);
  assertNoErrors('audit-empty-files-passes', passErrors);

  // Failing: audit mode with non-empty files_affected
  const failData = {
    execution_mode: 'audit',
    files_affected: ['src/hack.js'],
  };
  const failErrors = validateSemantics('final-review', failData);
  assertHasError('audit-nonempty-files-fails', failErrors, 'audit-no-source-edits');
}

// ---------------------------------------------------------------------------
// Rule 2: audit-no-forger
// ---------------------------------------------------------------------------

function testAuditNoForger() {
  console.log('\n[Rule 2: audit-no-forger]');

  // Passing: audit mode without forger tasks
  const passData = {
    execution_mode: 'audit',
    tasks: [
      { task_id: 't1', assigned_role: 'scout', objective: 'Review code', status: 'complete' },
    ],
  };
  const passErrors = validateSemantics('task-graph', passData);
  assertNoErrors('audit-no-forger-passes', passErrors);

  // Failing: audit mode with forger task
  const failData = {
    execution_mode: 'audit',
    tasks: [
      { task_id: 't1', assigned_role: 'forger', objective: 'Should not exist', status: 'complete' },
    ],
  };
  const failErrors = validateSemantics('task-graph', failData);
  assertHasError('audit-with-forger-fails', failErrors, 'audit-no-forger');
}

// ---------------------------------------------------------------------------
// Rule 3: implementation-needs-sentinel
// ---------------------------------------------------------------------------

function testImplementationNeedsSentinel() {
  console.log('\n[Rule 3: implementation-needs-sentinel]');

  // Passing: non-audit mode with sentinel task
  const passData = {
    execution_mode: 'standard',
    tasks: [
      { task_id: 't1', assigned_role: 'scout', objective: 'Explore', status: 'complete' },
      { task_id: 't2', assigned_role: 'sentinel', objective: 'Verify', status: 'complete' },
    ],
  };
  const passErrors = validateSemantics('task-graph', passData);
  assertNoErrors('has-sentinel-passes', passErrors);

  // Failing: non-audit mode without sentinel task
  const failData = {
    execution_mode: 'standard',
    tasks: [
      { task_id: 't1', assigned_role: 'scout', objective: 'Explore', status: 'complete' },
      { task_id: 't2', assigned_role: 'forger', objective: 'Code', status: 'complete' },
    ],
  };
  const failErrors = validateSemantics('task-graph', failData);
  assertHasError('no-sentinel-fails', failErrors, 'implementation-needs-sentinel');
}

// ---------------------------------------------------------------------------
// Rule 4: fix-cycles-within-preset
// ---------------------------------------------------------------------------

function testFixCyclesWithinPreset() {
  console.log('\n[Rule 4: fix-cycles-within-preset]');

  // Passing: quick mode with 0 cycles
  const passData = { execution_mode: 'quick', fix_cycles_used: 0 };
  const passErrors = validateSemantics('final-review', passData);
  assertNoErrors('quick-0-cycles-passes', passErrors);

  // Passing: standard mode with 2 cycles
  const passData2 = { execution_mode: 'standard', fix_cycles_used: 2 };
  const passErrors2 = validateSemantics('final-review', passData2);
  assertNoErrors('standard-2-cycles-passes', passErrors2);

  // Failing: quick mode with 2 cycles (max 1)
  const failData = { execution_mode: 'quick', fix_cycles_used: 2 };
  const failErrors = validateSemantics('final-review', failData);
  assertHasError('quick-2-cycles-fails', failErrors, 'fix-cycles-within-preset');

  // Failing: audit mode with 1 cycle (max 0)
  const failData2 = { execution_mode: 'audit', fix_cycles_used: 1 };
  const failErrors2 = validateSemantics('final-review', failData2);
  assertHasError('audit-1-cycle-fails', failErrors2, 'fix-cycles-within-preset');
}

// ---------------------------------------------------------------------------
// Rule 5: complete-no-fail-verdict
// ---------------------------------------------------------------------------

function testCompleteNoFailVerdict() {
  console.log('\n[Rule 5: complete-no-fail-verdict]');

  // Passing: complete run with PASS verdict
  const passData = { run_status: 'complete', sentinel_verdict: 'PASS' };
  const passErrors = validateSemantics('final-review', passData);
  assertNoErrors('complete-pass-passes', passErrors);

  // Failing: complete run with FAIL verdict
  const failData = { run_status: 'complete', sentinel_verdict: 'FAIL' };
  const failErrors = validateSemantics('final-review', failData);
  assertHasError('complete-fail-fails', failErrors, 'complete-no-fail-verdict');

  // Failing: complete run with BLOCKED verdict
  const failData2 = { run_status: 'complete', sentinel_verdict: 'BLOCKED' };
  const failErrors2 = validateSemantics('final-review', failData2);
  assertHasError('complete-blocked-fails', failErrors2, 'complete-no-fail-verdict');
}

// ---------------------------------------------------------------------------
// Rule 6: pass-no-critical-findings
// ---------------------------------------------------------------------------

function testPassNoCriticalFindings() {
  console.log('\n[Rule 6: pass-no-critical-findings]');

  // Passing: PASS verdict with no findings
  const passData = { sentinel_verdict: 'PASS' };
  const passErrors = validateSemantics('final-review', passData);
  assertNoErrors('pass-no-findings-passes', passErrors);

  // Passing: PASS verdict with low confidence findings
  const passData2 = { sentinel_verdict: 'PASS', findings: [{ statement: 'Minor issue', confidence: 'low' }] };
  const passErrors2 = validateSemantics('final-review', passData2);
  assertNoErrors('pass-low-findings-passes', passErrors2);

  // Failing: PASS verdict with high confidence finding
  const failData = { sentinel_verdict: 'PASS', findings: [{ statement: 'Critical issue', confidence: 'high' }] };
  const failErrors = validateSemantics('final-review', failData);
  assertHasError('pass-high-finding-fails', failErrors, 'pass-no-critical-findings');

  // Failing: PASS_WITH_LIMITATIONS with high severity risk
  const failData2 = { sentinel_verdict: 'PASS_WITH_LIMITATIONS', risks: [{ description: 'High risk', severity: 'high' }] };
  const failErrors2 = validateSemantics('final-review', failData2);
  assertHasError('pass-limitations-high-risk-fails', failErrors2, 'pass-no-critical-findings');
}

// ---------------------------------------------------------------------------
// Rule 7: evidence-refs-exist
// ---------------------------------------------------------------------------

function testEvidenceRefsExist() {
  console.log('\n[Rule 7: evidence-refs-exist]');

  // Passing: refs match available evidence IDs
  const passData = { evidence_refs: ['ev-001', 'ev-002'] };
  const passContext = { evidenceIds: ['ev-001', 'ev-002', 'ev-003'] };
  const passErrors = validateSemantics('role-handoff', passData, passContext);
  assertNoErrors('valid-refs-passes', passErrors);

  // Failing: ref points to non-existent evidence
  const failData = { evidence_refs: ['ev-999'] };
  const failContext = { evidenceIds: ['ev-001', 'ev-002'] };
  const failErrors = validateSemantics('role-handoff', failData, failContext);
  assertHasError('missing-ref-fails', failErrors, 'evidence-refs-exist');

  // Passing: no context — rule skipped
  const noCtxData = { evidence_refs: ['ev-999'] };
  const noCtxErrors = validateSemantics('role-handoff', noCtxData);
  assertNoErrors('no-context-skipped', noCtxErrors);
}

// ---------------------------------------------------------------------------
// Rule 8: test-claims-need-evidence
// ---------------------------------------------------------------------------

function testTestClaimsNeedEvidence() {
  console.log('\n[Rule 8: test-claims-need-evidence]');

  // Passing: mentions tests and has command evidence
  const passData = {
    changes: ['Added unit tests'],
    evidence: [{ type: 'command', evidence_id: 'ev-001' }],
  };
  const passErrors = validateSemantics('final-review', passData);
  assertNoErrors('test-claim-with-evidence-passes', passErrors);

  // Failing: mentions tests but no evidence
  const failData = {
    changes: ['Added unit tests'],
    evidence_refs: [],
    verification: ['All tests pass'],
  };
  const failErrors = validateSemantics('final-review', failData);
  assertHasError('test-claim-no-evidence-fails', failErrors, 'test-claims-need-evidence');
}

// ---------------------------------------------------------------------------
// Rule 9: dependencies-reference-real-tasks
// ---------------------------------------------------------------------------

function testDependenciesReferenceRealTasks() {
  console.log('\n[Rule 9: dependencies-reference-real-tasks]');

  // Passing: all deps reference real tasks
  const passData = {
    tasks: [
      { task_id: 't1', assigned_role: 'scout', objective: 'Explore', dependencies: [], status: 'complete' },
      { task_id: 't2', assigned_role: 'forger', objective: 'Build', dependencies: ['t1'], status: 'complete' },
      { task_id: 't3', assigned_role: 'sentinel', objective: 'Verify', dependencies: ['t2'], status: 'complete' },
    ],
  };
  const passErrors = validateSemantics('task-graph', passData);
  assertNoErrors('valid-deps-pass', passErrors);

  // Failing: dep references non-existent task
  const failData = {
    tasks: [
      { task_id: 't1', assigned_role: 'scout', objective: 'Explore', dependencies: ['nonexistent'], status: 'complete' },
    ],
  };
  const failErrors = validateSemantics('task-graph', failData);
  assertHasError('invalid-dep-fails', failErrors, 'dependencies-reference-real-tasks');
}

// ---------------------------------------------------------------------------
// Rule 10: no-cyclic-dependencies
// ---------------------------------------------------------------------------

function testNoCyclicDependencies() {
  console.log('\n[Rule 10: no-cyclic-dependencies]');

  // Passing: no cycles
  const passData = {
    tasks: [
      { task_id: 't1', assigned_role: 'scout', objective: 'A', dependencies: [], status: 'complete' },
      { task_id: 't2', assigned_role: 'forger', objective: 'B', dependencies: ['t1'], status: 'complete' },
      { task_id: 't3', assigned_role: 'sentinel', objective: 'C', dependencies: ['t2'], status: 'complete' },
    ],
  };
  const passErrors = validateSemantics('task-graph', passData);
  assertNoErrors('acyclic-passes', passErrors);

  // Failing: A -> B -> C -> A cycle
  const failData = {
    tasks: [
      { task_id: 't1', assigned_role: 'scout', objective: 'A', dependencies: ['t3'], status: 'complete' },
      { task_id: 't2', assigned_role: 'forger', objective: 'B', dependencies: ['t1'], status: 'complete' },
      { task_id: 't3', assigned_role: 'sentinel', objective: 'C', dependencies: ['t2'], status: 'complete' },
    ],
  };
  const failErrors = validateSemantics('task-graph', failData);
  assertHasError('cyclic-fails', failErrors, 'no-cyclic-dependencies');
}

// ---------------------------------------------------------------------------
// Rule 11: shared-run-id
// ---------------------------------------------------------------------------

function testSharedRunId() {
  console.log('\n[Rule 11: shared-run-id]');

  // Passing: matches expected run_id
  const passData = { run_id: 'run-001' };
  const passContext = { expectedRunId: 'run-001' };
  const passErrors = validateSemantics('final-review', passData, passContext);
  assertNoErrors('matching-run-id-passes', passErrors);

  // Failing: mismatched run_id
  const failData = { run_id: 'run-002' };
  const failContext = { expectedRunId: 'run-001' };
  const failErrors = validateSemantics('final-review', failData, failContext);
  assertHasError('mismatched-run-id-fails', failErrors, 'shared-run-id');

  // Passing: no context provided
  const noCtxData = { run_id: 'anything' };
  const noCtxErrors = validateSemantics('final-review', noCtxData);
  assertNoErrors('no-context-skipped', noCtxErrors);
}

// ---------------------------------------------------------------------------
// Rule 12: compatible-protocol-versions
// ---------------------------------------------------------------------------

function testCompatibleProtocolVersions() {
  console.log('\n[Rule 12: compatible-protocol-versions]');

  // Passing: version 1.0.0
  const passData = { protocol_version: '1.0.0' };
  const passErrors = validateSemantics('final-review', passData);
  assertNoErrors('v1.0.0-passes', passErrors);

  // Passing: version 1.5.0
  const passData2 = { protocol_version: '1.5.0' };
  const passErrors2 = validateSemantics('final-review', passData2);
  assertNoErrors('v1.5.0-passes', passErrors2);

  // Failing: version 0.5.0 (too old)
  const failData = { protocol_version: '0.5.0' };
  const failErrors = validateSemantics('final-review', failData);
  assertHasError('v0.5.0-fails', failErrors, 'compatible-protocol-versions');

  // Failing: version 2.0.0 (too new)
  const failData2 = { protocol_version: '2.0.0' };
  const failErrors2 = validateSemantics('final-review', failData2);
  assertHasError('v2.0.0-fails', failErrors2, 'compatible-protocol-versions');
}

// ---------------------------------------------------------------------------
// Rule 13: secret-scanning
// ---------------------------------------------------------------------------

function testSecretScanning() {
  console.log('\n[Rule 13: secret-scanning]');

  // Passing: no secrets
  const passData = { result: 'Clean result without any secrets' };
  const passErrors = validateSemantics('final-review', passData);
  assertNoErrors('clean-text-passes', passErrors);

  // Failing: contains sk- pattern
  const failData = { result: 'The key is sk-abcdef1234567890ab' };
  const failErrors = validateSemantics('final-review', failData);
  assertHasError('sk-pattern-flagged', failErrors, 'warn:secret-scanning');

  // Failing: contains private key block
  const failData2 = { result: 'Contains BEGIN PRIVATE KEY block' };
  const failErrors2 = validateSemantics('final-review', failData2);
  assertHasError('private-key-flagged', failErrors2, 'warn:secret-scanning');

  // Failing: contains Bearer token
  const failData3 = { result: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.token' };
  const failErrors3 = validateSemantics('final-review', failData3);
  assertHasError('bearer-token-flagged', failErrors3, 'warn:secret-scanning');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log('='.repeat(60));
  console.log('  HIVE Protocol Semantic Rule Tests');
  console.log('='.repeat(60));

  testAuditNoSourceEdits();
  testAuditNoForger();
  testImplementationNeedsSentinel();
  testFixCyclesWithinPreset();
  testCompleteNoFailVerdict();
  testPassNoCriticalFindings();
  testEvidenceRefsExist();
  testTestClaimsNeedEvidence();
  testDependenciesReferenceRealTasks();
  testNoCyclicDependencies();
  testSharedRunId();
  testCompatibleProtocolVersions();
  testSecretScanning();

  // Summary
  console.log('\n' + '='.repeat(60));
  const total = passed + failed;
  console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  - ${f.label}: ${f.detail}`);
    }
    console.log();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
