// Conformance Report --check Mode Regression Tests
// Verifies --check detects current, stale, and missing report states.

'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'generate-conformance-report.js');
const REPORT = path.join(ROOT, 'docs', 'CONFORMANCE.md');

let allPassed = true;
let totalChecks = 0;
let passedChecks = 0;

function check(label, condition) {
  totalChecks++;
  if (condition) {
    console.log(`PASS: ${label}`);
    passedChecks++;
  } else {
    console.error(`FAIL: ${label}`);
    allPassed = false;
  }
}

function run(args) {
  try {
    const output = execSync(`node "${TOOL}" ${args}`, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, output: output.trim(), code: 0 };
  } catch (err) {
    return {
      ok: false,
      output: (err.stdout || '').trim() + '\n' + (err.stderr || '').trim(),
      code: err.status,
    };
  }
}

console.log('\n=== Conformance Report --check Regression Tests ===\n');

// ---- 1. Current report passes --check ----
const checkResult = run('--check');
check('--check passes when report is current', checkResult.ok && checkResult.output.includes('up to date'));

// ---- 2. Missing report fails --check ----
const backup = REPORT + '.bak';
if (fs.existsSync(REPORT)) {
  fs.renameSync(REPORT, backup);
}
const missingResult = run('--check');
check('--check fails when report is missing', !missingResult.ok && missingResult.code === 1 && missingResult.output.includes('missing'));
// Restore report
if (fs.existsSync(backup)) {
  fs.renameSync(backup, REPORT);
}

// ---- 3. Stale report fails --check ----
const original = fs.readFileSync(REPORT, 'utf8');
fs.writeFileSync(REPORT, '# Stale content\n', 'utf8');
const staleResult = run('--check');
check('--check fails when report is stale', !staleResult.ok && staleResult.code === 1 && staleResult.output.includes('stale'));
// Restore original
fs.writeFileSync(REPORT, original, 'utf8');

// ---- 4. Running without --check writes the file ----
fs.unlinkSync(REPORT);
const writeResult = run('');
check('generate writes report without --check', writeResult.ok && fs.existsSync(REPORT));
if (!fs.existsSync(REPORT)) {
  // Re-generate if test deleted it
  run('');
}

// ---- 5. After write, --check passes ----
const finalCheck = run('--check');
check('--check passes after fresh write', finalCheck.ok && finalCheck.output.includes('up to date'));

console.log(`\n=== Results: ${passedChecks}/${totalChecks} passed ===\n`);
process.exit(allPassed ? 0 : 1);
