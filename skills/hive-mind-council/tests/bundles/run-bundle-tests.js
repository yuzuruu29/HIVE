#!/usr/bin/env node

/**
 * run-bundle-tests.js — Bundle validation tests
 *
 * Validates complete bundle directories using the HIVE validation CLI.
 * Tests both valid and invalid bundles.
 *
 * Usage:
 *   node tests/bundles/run-bundle-tests.js
 *
 * Exit code:
 *   0  — all bundle tests pass
 *   1  — one or more bundle tests fail
 */

'use strict';

const path = require('path');
const { validateBundle } = require('../../tools/hive-validate');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BUNDLES_DIR = path.resolve(__dirname);

const BUNDLE_TESTS = [
  {
    name: 'valid/complete-run',
    dir: path.join(BUNDLES_DIR, 'valid', 'complete-run'),
    expectValid: true,
    description: 'A complete, valid run bundle should pass validation',
  },
  {
    name: 'invalid/cross-run-ids',
    dir: path.join(BUNDLES_DIR, 'invalid', 'cross-run-ids'),
    expectValid: false,
    description: 'A bundle with mismatched run_ids should fail validation',
  },
];

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log('='.repeat(60));
  console.log('  HIVE Protocol Bundle Tests');
  console.log('='.repeat(60));

  for (const test of BUNDLE_TESTS) {
    console.log(`\n[Bundle: ${test.name}]`);
    console.log(`  ${test.description}`);

    try {
      const result = validateBundle(test.dir);
      const isValid = result.valid;

      if (test.expectValid && isValid) {
        reportPass(test.name);
      } else if (!test.expectValid && !isValid) {
        reportPass(test.name);
      } else if (test.expectValid && !isValid) {
        const errors = [];
        if (result.results) {
          for (const r of result.results) {
            if (!r.valid) {
              const schemaErrs = r.schema_errors.map(e => e.message || e.keyword).join('; ');
              const semanticErrs = r.semantic_errors.map(e => `[${e.rule}] ${e.message}`).join('; ');
              errors.push(`${r.label}: ${schemaErrs} ${semanticErrs}`);
            }
          }
        }
        reportFail(test.name, `Expected valid but got invalid: ${errors.join(' | ')}`);
      } else {
        reportFail(test.name, 'Expected invalid but got valid');
      }
    } catch (err) {
      reportFail(test.name, `Exception: ${err.message}`);
    }
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
