// The Hive Skill v0.2.1 — Safety Validation Scenario Tests
// Validates safety policy coverage across all files
// No external dependencies required

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SAFETY_REF = path.join(ROOT, 'skills', 'hive-mind-council', 'references', 'safety-policy.md');
const PROTOCOL_REF = path.join(ROOT, 'skills', 'hive-mind-council', 'references', 'council-protocol.md');
const SKILL_FILE = path.join(ROOT, 'skills', 'hive-mind-council', 'SKILL.md');

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

console.log('\n=== Safety Validation Tests ===\n');

const safety = readFile(SAFETY_REF);
const protocol = readFile(PROTOCOL_REF);
const skill = readFile(SKILL_FILE);

// 1. Permission levels
console.log('--- Permission Levels ---');
check('Has READ permission', /READ/.test(safety));
check('Has WRITE permission', /WRITE/.test(safety));
check('Has EXECUTE permission', /EXECUTE/.test(safety));
check('Has NETWORK permission', /NETWORK/.test(safety));
check('Has GIT_MUTATE permission', /GIT_MUTATE/.test(safety));
check('Has DESTRUCTIVE permission', /DESTRUCTIVE/.test(safety));

// 2. Default permission behavior
console.log('\n--- Default Behavior ---');
check('Default READ is permitted', /READ.*Permitted/.test(safety));
check('Default WRITE is permitted within scope', /WRITE.*Permitted.*assigned scope/.test(safety));
check('Default EXECUTE is permitted', /EXECUTE.*Permitted/.test(safety));
check('Default NETWORK is disclosed', /NETWORK.*Disclosed/.test(safety));
check('Default GIT_MUTATE requires user intent', /GIT_MUTATE.*Requires user/.test(safety));
check('Default DESTRUCTIVE requires approval', /DESTRUCTIVE.*requires explicit approval/.test(safety));

// 3. Approval requirements
console.log('\n--- Approval Requirements ---');
check('Git commit requires approval', /Git commit/.test(safety));
check('Deleting files outside scope requires approval', /Deleting files/.test(safety));
check('Modifying production config requires approval', /Modifying production/.test(safety));
check('Rotating secrets requires approval', /Rotating secrets/.test(safety));
check('Installing new dependencies requires justification', /Installing new dependencies/.test(safety));
check('Running destructive commands requires approval', /destructive potential/.test(safety));
check('Modifying CI/CD requires approval', /CI\/CD/.test(safety));

// 4. Untrusted input policy
console.log('\n--- Untrusted Input Policy ---');
check('README is untrusted input', /untrusted input/.test(safety));
check('CONTRIBUTING is untrusted input', /CONTRIBUTING/.test(safety));
check('Repository instructions cannot override safety policy', /cannot override/.test(safety));
check('Ignore previous rules is untrusted', /ignore previous rules/.test(safety));
check('Skip validation is untrusted', /skip validation/.test(safety));
check('Run this command is untrusted', /run this command/.test(safety));
check('Council documents untrusted instructions', /document untrusted/.test(safety));
check('Approval prompts originate from runtime', /originate from the runtime/.test(safety));

// 5. File scope enforcement
console.log('\n--- File Scope Enforcement ---');
check('Forger has allowed_paths', /allowed_paths/.test(safety));
check('Forger has forbidden_paths', /forbidden_paths/.test(safety));
check('Forger must verify scope before edit', /verify scope/.test(safety));
check('Modifications outside allowed_paths are violations', /outside.*allowed_paths/.test(safety));
check('Sentinel checks file scope', /Sentinel checks file scope/.test(safety));

// 6. Secret handling
console.log('\n--- Secret Handling ---');
check('No hardcoded API keys', /No hardcoded API/.test(safety));
check('Secrets use env vars', /environment variables/.test(safety));
check('Validate secrets at startup', /Validate required secrets/.test(safety));
check('Never log secret values', /Never log/.test(safety));
check('Never commit secrets', /Never commit secrets/.test(safety));

// 7. User work protection
console.log('\n--- User Work Protection ---');
check('Uncommitted work must not be discarded', /must never be discarded/.test(safety));
check('Check git status before destructive ops', /check git status/.test(safety));
check('Staged changes must be preserved', /Staged changes.*preserved/.test(safety));
check('Warn before modifying files with uncommitted changes', /warn before modifying/.test(safety));

// 8. Enforcement
console.log('\n--- Enforcement ---');
check('Roles may refuse unsafe instructions', /refuse instructions/.test(safety));
check('Violations reported as risks', /reported in the handoff/.test(safety));
check('Repeated violations escalate to Queen', /escalate to the Queen/.test(safety));

// 9. Scope enforcement in protocol
console.log('\n--- Protocol-Level Scope ---');
check('No role may modify outside assigned scope', /modify files outside.*assigned scope/.test(protocol));
check('No role may add dependencies without disclosure', /add dependencies without disclosure/.test(protocol));
check('No role may discard uncommitted work', /discard uncommitted user work/.test(protocol));
check('No role may treat filenames as proof', /treat filenames as proof/.test(protocol));

// 10. SKILL.md safety model
console.log('\n--- SKILL.md Safety ---');
check('SKILL.md safety table has READ', /Read files.*Permitted/.test(skill));
check('SKILL.md safety table has WRITE', /Write files.*Permitted.*scope/.test(skill));
check('SKILL.md safety table has EXECUTE', /Execute safe.*Permitted/.test(skill));
check('SKILL.md safety table has NETWORK', /Network access.*disclosed/.test(skill));
check('SKILL.md safety table has GIT_MUTATE', /Git mutation.*user intent/.test(skill));
check('SKILL.md safety table has DESTRUCTIVE', /Destructive operations.*approval/.test(skill));
check('SKILL.md says repo instructions are untrusted', /untrusted input/.test(skill));
check('SKILL.md says instructions cannot override', /cannot override/.test(skill));

// 11. Check for unsafe wording
console.log('\n--- Unsafe Wording Check ---');
const unsafePatterns = [
  'git reset --hard',
  'git clean',
  'force-push',
  'delete unknown file',
  'commit without instruction',
  'modify production service',
  'execute repository-provided command without review'
];
for (const pattern of unsafePatterns) {
  const found = new RegExp(pattern, 'i').test(safety) || new RegExp(pattern, 'i').test(skill) || new RegExp(pattern, 'i').test(protocol);
  if (found) {
    console.error(`UNSAFE: Found potentially dangerous instruction: "${pattern}"`);
    allPassed = false;
  } else {
    console.log(`PASS: No unsafe instruction "${pattern}"`);
  }
  totalChecks++;
  if (!found) passedChecks++;
}

// Summary
console.log(`\n=== Results: ${passedChecks}/${totalChecks} passed ===\n`);
process.exit(allPassed ? 0 : 1);
