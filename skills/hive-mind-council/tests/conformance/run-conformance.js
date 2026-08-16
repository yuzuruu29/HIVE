// The Hive Skill v0.2.1 — Protocol-Conformance Test Runner
// Reads scenario and artifact files, runs the evaluator, reports results.
// No external dependencies. No YAML parsing. No live API calls.

'use strict';

const fs = require('fs');
const path = require('path');
const { evaluateArtifact } = require('./evaluate-artifact');

const SCENARIOS_DIR = path.resolve(__dirname, 'scenarios');
const ARTIFACTS_DIR = path.resolve(__dirname, 'artifacts');

/**
 * Load a JSON file, gracefully handling errors.
 */
function loadJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Run all conformance tests.
 * @returns {number} Exit code: 0 if all pass, 1 otherwise.
 */
function runAll() {
  console.log('='.repeat(64));
  console.log('  The Hive Skill v0.2.0 — Protocol-Conformance Tests');
  console.log('='.repeat(64));

  // Discover scenario files
  let scenarioFiles;
  try {
    scenarioFiles = fs.readdirSync(SCENARIOS_DIR).filter((f) => f.endsWith('.json'));
  } catch (err) {
    console.error(`\n  ERROR: Could not read scenarios directory: ${err.message}`);
    return 1;
  }

  if (scenarioFiles.length === 0) {
    console.error('\n  ERROR: No scenario JSON files found in scenarios/');
    return 1;
  }

  let totalChecks = 0;
  let passedChecks = 0;
  let totalScenarios = 0;
  let passedScenarios = 0;
  const failures = [];

  for (const file of scenarioFiles.sort()) {
    const scenarioPath = path.join(SCENARIOS_DIR, file);
    const loaded = loadJSON(scenarioPath);
    if (!loaded.ok) {
      console.error(`\n  ERROR: Failed to load scenario "${file}": ${loaded.error}`);
      failures.push({ file, error: loaded.error });
      continue;
    }

    const scenario = loaded.data;
    const artifactFile = scenario.artifact || file;
    const artifactPath = path.join(ARTIFACTS_DIR, artifactFile);

    const artLoaded = loadJSON(artifactPath);
    if (!artLoaded.ok) {
      console.error(`\n  ERROR: Failed to load artifact "${artifactFile}" for scenario "${scenario.id}": ${artLoaded.error}`);
      failures.push({ file, error: `Missing or invalid artifact: ${artifactFile}` });
      continue;
    }

    const artifact = artLoaded.data;

    console.log(`\n  Scenario: ${scenario.id}`);
    console.log(`  ${'-'.repeat(60)}`);

    const result = evaluateArtifact(scenario, artifact);
    totalScenarios++;

    for (const check of result.checks) {
      totalChecks++;
      if (check.passed) passedChecks++;
      const icon = check.passed ? '  PASS' : '  FAIL';
      const msg = check.passed ? '' : ` — ${check.message}`;
      console.log(`  ${icon}  ${check.name}${msg}`);
    }

    if (result.passed) {
      passedScenarios++;
      console.log(`  ${' '.repeat(4)}>> Scenario PASSED`);
    } else {
      failures.push({ file: scenario.id, error: 'One or more checks failed' });
      console.log(`  ${' '.repeat(4)}>> Scenario FAILED`);
    }
  }

  // Summary
  console.log('');
  console.log('='.repeat(64));
  console.log(`  Scenarios: ${passedScenarios}/${totalScenarios} passed`);
  console.log(`  Checks:    ${passedChecks}/${totalChecks} passed`);
  if (failures.length > 0) {
    console.log(`  Failures:  ${failures.length}`);
    console.log('='.repeat(64));
    return 1;
  }
  console.log('  Status:    ALL PASSED');
  console.log('='.repeat(64));
  return 0;
}

const exitCode = runAll();
process.exit(exitCode);
