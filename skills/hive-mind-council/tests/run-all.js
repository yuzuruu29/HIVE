// The Hive Skill v0.2.1 — Validation Test Runner
// Runs all contract, scenario, and safety tests
// No external dependencies required

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIRS = [
  'contracts/handoff-schema.test.js',
  'contracts/yaml-templates.test.js',
  'scenarios/preset-selection.test.js',
  'scenarios/safety-validation.test.js'
];

let exitCode = 0;
let completed = 0;

function runTest(testFile) {
  return new Promise((resolve) => {
    const fullPath = path.join(ROOT, 'tests', testFile);
    const proc = spawn('node', [fullPath], {
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test' }
    });

    proc.on('close', (code) => {
      completed++;
      if (code !== 0) exitCode = 1;
      resolve();
    });

    proc.on('error', (err) => {
      console.error(`Failed to start test ${testFile}:`, err.message);
      exitCode = 1;
      resolve();
    });
  });
}

async function main() {
  console.log('='.repeat(60));
  console.log('  The Hive Skill v0.2.0 — Validation Test Suite');
  console.log('='.repeat(60));

  for (const testFile of TEST_DIRS) {
    console.log(`\nRunning: ${testFile}`);
    console.log('-'.repeat(40));
    await runTest(testFile);
  }

  console.log('='.repeat(60));
  console.log(`  Completed: ${completed}/${TEST_DIRS.length} test suites`);
  console.log(`  Overall: ${exitCode === 0 ? 'ALL PASSED' : 'SOME FAILED'}`);
  console.log('='.repeat(60));

  process.exit(exitCode);
}

main();
