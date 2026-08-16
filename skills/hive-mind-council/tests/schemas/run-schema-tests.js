#!/usr/bin/env node

/**
 * run-schema-tests.js — Schema validation test runner
 *
 * Loads all HIVE Protocol JSON Schema files, verifies they compile with Ajv,
 * then validates valid and invalid fixtures against each schema.
 *
 * Usage:
 *   node tests/schemas/run-schema-tests.js
 *
 * Exit code:
 *   0  — all tests pass
 *   1  — one or more tests fail
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { validateArtifact } = require('../../tools/load-schema');
const { validateSemantics } = require('../../tools/semantic-rules');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SCHEMAS_DIR = path.resolve(__dirname, '..', '..', 'schemas', 'v1');
const VALID_DIR = path.resolve(__dirname, 'valid');
const INVALID_DIR = path.resolve(__dirname, 'invalid');

// Map fixture filenames to their expected artifact type
const FIXTURE_TYPE_MAP = {
  // Valid fixtures
  'quick-readme-fix.json': 'final-review',
  'standard-bugfix.json': 'final-review',
  'audit-readonly.json': 'final-review',
  'blocked-credentials.json': 'final-review',
  'injection-ignored.json': 'final-review',
  // Invalid fixtures
  'unknown-run-status.json': 'final-review',
  'unknown-confidence.json': 'role-handoff',
  'missing-run-id.json': 'final-review',
  'empty-success-criteria.json': 'run-contract',
  'complete-with-failed-sentinel.json': 'final-review',
  'audit-with-modified-files.json': 'final-review',
  'audit-with-forger.json': 'task-graph',
  'impl-without-sentinel.json': 'task-graph',
  'fix-cycles-over-limit.json': 'final-review',
  'missing-evidence-ref.json': 'role-handoff',
  'pass-with-critical-findings.json': 'final-review',
  'circular-dependency.json': 'task-graph',
  'cross-run-artifact.json': 'final-review',
  'unsupported-protocol-version.json': 'final-review',
  'secret-in-final-review.json': 'final-review',
  'malformed-adapter-claim.json': 'adapter-manifest',
  'duplicate-task-id.json': 'task-graph',
  'empty-goal.json': 'run-contract',
  'negative-fix-cycles.json': 'run-contract',
  'invalid-execution-mode.json': 'final-review',
};

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
  console.log(`  FAIL: ${label}`);
  failed++;
  failures.push({ label, detail });
}

// ---------------------------------------------------------------------------
// Test: Schema compilation
// ---------------------------------------------------------------------------

function testSchemaCompilation() {
  console.log('\n[Schema Compilation]');
  console.log('Verifying all v1 schemas compile with Ajv...\n');

  const schemaFiles = fs.readdirSync(SCHEMAS_DIR)
    .filter(f => f.endsWith('.schema.json'))
    .sort();

  for (const file of schemaFiles) {
    try {
      const raw = fs.readFileSync(path.join(SCHEMAS_DIR, file), 'utf8');
      JSON.parse(raw); // check it's valid JSON
      reportPass(`Schema compiles: ${file}`);
    } catch (err) {
      reportFail(`Schema compile: ${file}`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Test: Valid fixtures
// ---------------------------------------------------------------------------

function testValidFixtures() {
  console.log('\n[Valid Fixtures]');
  console.log('Verifying valid fixtures pass schema validation...\n');

  const files = fs.readdirSync(VALID_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();

  for (const file of files) {
    const filePath = path.join(VALID_DIR, file);
    const type = FIXTURE_TYPE_MAP[file];
    if (!type) {
      reportFail(file, `No artifact type mapping for "${file}"`);
      continue;
    }

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const result = validateArtifact(type, data);
      const semanticErrors = validateSemantics(type, data);
      const valid = result.valid && semanticErrors.length === 0;

      if (valid) {
        reportPass(file);
      } else {
        const errors = [];
        if (!result.valid) {
          errors.push(...result.errors.map(e => e.message || e.keyword || JSON.stringify(e)));
        }
        if (semanticErrors.length > 0) {
          errors.push(...semanticErrors.map(e => `[${e.rule}] ${e.message}`));
        }
        reportFail(file, errors.join('; '));
      }
    } catch (err) {
      reportFail(file, `Exception: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Test: Invalid fixtures
// ---------------------------------------------------------------------------

function testInvalidFixtures() {
  console.log('\n[Invalid Fixtures]');
  console.log('Verifying invalid fixtures fail validation...\n');

  const files = fs.readdirSync(INVALID_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();

  for (const file of files) {
    const filePath = path.join(INVALID_DIR, file);
    const type = FIXTURE_TYPE_MAP[file];
    if (!type) {
      reportFail(file, `No artifact type mapping for "${file}"`);
      continue;
    }

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const result = validateArtifact(type, data);
      const semanticErrors = validateSemantics(type, data);
      const valid = result.valid && semanticErrors.length === 0;

      if (!valid) {
        reportPass(file);
      } else {
        reportFail(file, `Expected validation to fail but it passed`);
      }
    } catch (err) {
      reportFail(file, `Exception: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log('='.repeat(60));
  console.log('  HIVE Protocol Schema Test Runner');
  console.log('='.repeat(60));

  testSchemaCompilation();
  testValidFixtures();
  testInvalidFixtures();

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
