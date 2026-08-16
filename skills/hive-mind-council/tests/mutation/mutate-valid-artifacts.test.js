#!/usr/bin/env node

/**
 * mutate-valid-artifacts.test.js — Mutation Tests
 *
 * Starts from a known-valid baseline artifact, applies targeted mutations,
 * and verifies that each mutation causes validation to fail.
 *
 * Ensures the CLI can detect field corruption, missing required fields,
 * invalid values, injected secrets, and cross-run contamination.
 *
 * Usage:
 *   node tests/mutation/mutate-valid-artifacts.test.js
 *
 * Exit code:
 *   0  — all mutation tests pass
 *   1  — one or more mutations were not detected
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { validateArtifact } = require('../../tools/load-schema');
const { validateSemantics } = require('../../tools/semantic-rules');

// ---------------------------------------------------------------------------
// Baseline artifact — the golden final-review.json from the valid bundle
// ---------------------------------------------------------------------------

const BASELINE_PATH = path.resolve(__dirname, '..', 'bundles', 'valid', 'complete-run', 'final-review.json');
const BASELINE = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function testMutation(name, mutateFn, artifactType) {
  const data = clone(BASELINE);
  try {
    mutateFn(data);
  } catch (err) {
    reportFail(name, `Mutation function threw: ${err.message}`);
    return;
  }

  const schemaResult = validateArtifact(artifactType || 'final-review', data);
  const semanticErrors = validateSemantics(artifactType || 'final-review', data);
  const valid = schemaResult.valid && semanticErrors.length === 0;

  if (!valid) {
    reportPass(name);
  } else {
    reportFail(name, 'Mutation did not cause validation to fail');
  }
}

function reportPass(label) {
  console.log(`  PASS: ${label}`);
  passed++;
}

function reportFail(label, detail) {
  console.log(`  FAIL: ${label} — ${detail}`);
  failed++;
  failures.push({ label, detail });
}

// ---------------------------------------------------------------------------
// Mutation definitions
// ---------------------------------------------------------------------------

const MUTATIONS = [
  // 1. Remove each required field from final-review
  { name: 'remove-protocol-version', mutate: (d) => { delete d.protocol_version; } },
  { name: 'remove-run-id', mutate: (d) => { delete d.run_id; } },
  { name: 'remove-run-status', mutate: (d) => { delete d.run_status; } },
  { name: 'remove-goal', mutate: (d) => { delete d.goal; } },
  { name: 'remove-result', mutate: (d) => { delete d.result; } },
  { name: 'remove-execution-mode', mutate: (d) => { delete d.execution_mode; } },
  { name: 'remove-fix-cycles-used', mutate: (d) => { delete d.fix_cycles_used; } },
  { name: 'remove-changes', mutate: (d) => { delete d.changes; } },
  { name: 'remove-evidence-refs', mutate: (d) => { delete d.evidence_refs; } },
  { name: 'remove-verification', mutate: (d) => { delete d.verification; } },
  { name: 'remove-limitations', mutate: (d) => { delete d.limitations; } },
  { name: 'remove-files-affected', mutate: (d) => { delete d.files_affected; } },
  { name: 'remove-sentinel-verdict', mutate: (d) => { delete d.sentinel_verdict; } },
  { name: 'remove-completed-at', mutate: (d) => { delete d.completed_at; } },

  // 2. Replace run_status with invalid value
  { name: 'replace-run-status-invalid', mutate: (d) => { d.run_status = 'invalid'; } },

  // 3. Replace execution_mode with invalid value
  { name: 'replace-execution-mode-invalid', mutate: (d) => { d.execution_mode = 'turbo'; } },

  // 4. Increment fix_cycles_used above limit (quick mode)
  { name: 'fix-cycles-over-limit', mutate: (d) => { d.execution_mode = 'quick'; d.fix_cycles_used = 99; } },

  // 5. Add a modified file to audit mode
  { name: 'audit-mode-with-file-changes', mutate: (d) => { d.execution_mode = 'audit'; d.files_affected = ['src/hack.js']; d.changes = ['Modified a file']; } },

  // 6. Replace sentinel_verdict
  { name: 'replace-sentinel-verdict-invalid', mutate: (d) => { d.sentinel_verdict = 'INCONCLUSIVE'; } },
  { name: 'complete-with-fail-verdict', mutate: (d) => { d.run_status = 'complete'; d.sentinel_verdict = 'FAIL'; } },

  // 7. Corrupt evidence_refs (wrong type)
  { name: 'evidence-refs-wrong-type', mutate: (d) => { d.evidence_refs = 'not-an-array'; } },

  // 8. Change run_id to wrong type
  { name: 'run-id-wrong-type', mutate: (d) => { d.run_id = 12345; } },

  // 9. Insert secret-like content (sk-xxx)
  { name: 'insert-secret-api-key', mutate: (d) => { d.result = 'Contains sk-mysecretapikey1234567890abcdefgh'; } },

  // 10. Corrupt changes field (wrong type)
  { name: 'changes-wrong-type', mutate: (d) => { d.changes = 'not-an-array'; } },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log('='.repeat(60));
  console.log('  HIVE Protocol Mutation Tests');
  console.log('='.repeat(60));
  console.log(`\nBaseline: ${path.relative(path.resolve(__dirname, '..', '..'), BASELINE_PATH)}`);
  console.log(`Mutations: ${MUTATIONS.length}\n`);

  // Verify baseline is valid first
  console.log('[Sanity Check]');
  const baselineResult = validateArtifact('final-review', BASELINE);
  const baselineSemantic = validateSemantics('final-review', BASELINE);
  if (baselineResult.valid && baselineSemantic.length === 0) {
    console.log('  PASS: Baseline artifact is valid\n');
  } else {
    console.log('  FAIL: Baseline artifact is invalid. Tests may be unreliable.\n');
  }

  console.log('[Mutations]');
  for (const mutation of MUTATIONS) {
    testMutation(mutation.name, mutation.mutate, 'final-review');
  }

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
