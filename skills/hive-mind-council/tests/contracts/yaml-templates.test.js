// The Hive Skill v0.2.1 — YAML Template Contract Test
// Validates YAML templates have correct structure and required fields
// No external dependencies required - uses regex-based validation

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES_DIR = path.join(ROOT, 'skills', 'hive-mind-council', 'templates');
const EXAMPLES_DIR = path.join(ROOT, 'skills', 'hive-mind-council', 'examples');

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

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

console.log('\n=== YAML Template Validation ===\n');

// 1. run-contract.yaml
console.log('--- run-contract.yaml ---');
const runContract = readFile(path.join(TEMPLATES_DIR, 'run-contract.yaml'));
check('run-contract.yaml exists', !!runContract);
if (runContract) {
  check('Has goal field', /goal:/.test(runContract));
  check('Has deliverables field', /deliverables:/.test(runContract));
  check('Has constraints field', /constraints:/.test(runContract));
  check('Has exclusions field', /exclusions:/.test(runContract));
  check('Has success_criteria field', /success_criteria:/.test(runContract));
  check('Has approval_requirements field', /approval_requirements:/.test(runContract));
  check('Has execution_mode field', /execution_mode:/.test(runContract));
  check('Has maximum_fix_cycles field', /maximum_fix_cycles:/.test(runContract));
  check('Has status field', /status:/.test(runContract));
  check('execution_mode lists all 4 presets', /quick \| standard \| deep \| audit/.test(runContract));
  check('maximum_fix_cycles defaults to 2', /maximum_fix_cycles: 2/.test(runContract));
  check('status defaults to planning', /status: planning/.test(runContract));
}

// 2. role-handoff.yaml
console.log('\n--- role-handoff.yaml ---');
const roleHandoff = readFile(path.join(TEMPLATES_DIR, 'role-handoff.yaml'));
check('role-handoff.yaml exists', !!roleHandoff);
if (roleHandoff) {
  check('Has role field', /role:/.test(roleHandoff));
  check('Has status field with all 4 values', /complete \| blocked \| failed \| needs_approval/.test(roleHandoff));
  check('Has findings with evidence', /evidence:.*Source/.test(roleHandoff));
  check('Has findings with confidence', /confidence: (high|medium|low)/.test(roleHandoff));
  check('Has files_examined', /files_examined:/.test(roleHandoff));
  check('Has files_changed', /files_changed:/.test(roleHandoff));
  check('Has commands_run', /commands_run:/.test(roleHandoff));
  check('Has risks with severity', /severity: (low|medium|high)/.test(roleHandoff));
  check('Has unresolved_questions', /unresolved_questions:/.test(roleHandoff));
  check('Has recommended_next_action', /recommended_next_action:/.test(roleHandoff));
}

// 3. evidence-ledger.yaml
console.log('\n--- evidence-ledger.yaml ---');
const evidenceLedger = readFile(path.join(TEMPLATES_DIR, 'evidence-ledger.yaml'));
check('evidence-ledger.yaml exists', !!evidenceLedger);
if (evidenceLedger) {
  check('Has files_examined', /files_examined:/.test(evidenceLedger));
  check('Has files_modified', /files_modified:/.test(evidenceLedger));
  check('Has commands_executed', /commands_executed:/.test(evidenceLedger));
  check('Has test_results', /test_results:/.test(evidenceLedger));
  check('Has build_results', /build_results:/.test(evidenceLedger));
  check('Has behavioral_checks', /behavioral_checks:/.test(evidenceLedger));
  check('Has assumptions', /assumptions:/.test(evidenceLedger));
  check('Has unverified_claims', /unverified_claims:/.test(evidenceLedger));
  check('Has approvals', /approvals:/.test(evidenceLedger));
  check('Has remaining_risks', /remaining_risks:/.test(evidenceLedger));
}

// 4. final-review.yaml
console.log('\n--- final-review.yaml ---');
const finalReview = readFile(path.join(TEMPLATES_DIR, 'final-review.yaml'));
check('final-review.yaml exists', !!finalReview);
if (finalReview) {
  check('Has run_status', /run_status:/.test(finalReview));
  check('Has goal field', /goal:/.test(finalReview));
  check('Has execution_mode', /execution_mode:/.test(finalReview));
  check('Has fix_cycles_used', /fix_cycles_used:/.test(finalReview));
  check('Has result field', /result:/.test(finalReview));
  check('Has changes field', /changes:/.test(finalReview));
  check('Has evidence field', /evidence:/.test(finalReview));
  check('Has verification field', /verification:/.test(finalReview));
  check('Has limitations field', /limitations:/.test(finalReview));
  check('Has follow_up field', /follow_up:/.test(finalReview));
  check('Has files_affected', /files_affected:/.test(finalReview));
  check('Has approval_actions', /approval_actions:/.test(finalReview));
}

// 5. Validate examples match the run-contract schema
console.log('\n--- Example Run Contracts ---');
const exampleFiles = ['bugfix.md', 'feature-build.md', 'refactor.md', 'test-generation.md'];
for (const ex of exampleFiles) {
  const content = readFile(path.join(EXAMPLES_DIR, ex));
  check(`${ex} exists`, !!content);
  if (content) {
    check(`${ex} has goal in run contract`, /goal:/.test(content));
    check(`${ex} has deliverables`, /deliverables:/.test(content));
    check(`${ex} has success_criteria`, /success_criteria:/.test(content));
    check(`${ex} has execution_mode`, /execution_mode:/.test(content));
    check(`${ex} has maximum_fix_cycles`, /maximum_fix_cycles:/.test(content));
    check(`${ex} has status: planning`, /status: planning/.test(content));
    check(`${ex} ends with Queen final decision`, /Queen[\s\S]*?(?:Final|status)[\s\S]*?(?:Complete|Blocked|Failed)/.test(content));
  }
}

// Summary
console.log(`\n=== Results: ${passedChecks}/${totalChecks} passed ===\n`);
process.exit(allPassed ? 0 : 1);
