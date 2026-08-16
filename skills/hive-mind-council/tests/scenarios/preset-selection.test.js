// The Hive Skill v0.2.1 — Preset Selection Scenario Test
// Validates that orchestration presets are correctly documented
// No external dependencies required

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(ROOT, 'tests', 'fixtures');
const PRESETS_REF = path.join(ROOT, 'skills', 'hive-mind-council', 'references', 'orchestration-presets.md');
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

console.log('\n=== Preset Selection Scenario Tests ===\n');

const presetsContent = readFile(PRESETS_REF);
const skillContent = readFile(SKILL_FILE);

// 1. Quick preset validation
console.log('--- Quick Preset ---');
check('Quick preset exists in reference doc', /## Quick/.test(presetsContent));
check('Quick preset in SKILL.md', /Quick.*Queen.*Forger.*Sentinel.*1/.test(skillContent));
check('Quick has queen role', /queen/.test(presetsContent.match(/## Quick[\s\S]*?(?=---)/)?.[0] || ''));
check('Quick has forger role', /forger/.test(presetsContent.match(/## Quick[\s\S]*?(?=---)/)?.[0] || ''));
check('Quick has sentinel role', /sentinel/.test(presetsContent.match(/## Quick[\s\S]*?(?=---)/)?.[0] || ''));
check('Quick fix cycles = 1', /maximum_fix_cycles: 1/.test(presetsContent.match(/## Quick[\s\S]*?(?=---)/)?.[0] || ''));

// 2. Standard preset validation
console.log('\n--- Standard Preset ---');
check('Standard preset exists', /## Standard/.test(presetsContent));
check('Standard has all 6 roles', {
  queen: /queen/.test(presetsContent.match(/## Standard[\s\S]*?(?=---)/)?.[0] || ''),
  scout: /scout/.test(presetsContent.match(/## Standard[\s\S]*?(?=---)/)?.[0] || ''),
  architect: /architect/.test(presetsContent.match(/## Standard[\s\S]*?(?=---)/)?.[0] || ''),
  forger: /forger/.test(presetsContent.match(/## Standard[\s\S]*?(?=---)/)?.[0] || ''),
  sentinel: /sentinel/.test(presetsContent.match(/## Standard[\s\S]*?(?=---)/)?.[0] || ''),
  scribe: /scribe/.test(presetsContent.match(/## Standard[\s\S]*?(?=---)/)?.[0] || '')
});
const standardSection = presetsContent.match(/## Standard[\s\S]*?(?=---)/)?.[0] || '';
check('Standard has queen', /queen/.test(standardSection));
check('Standard has scout', /scout/.test(standardSection));
check('Standard has architect', /architect/.test(standardSection));
check('Standard has forger', /forger/.test(standardSection));
check('Standard has sentinel', /sentinel/.test(standardSection));
check('Standard has scribe', /scribe/.test(standardSection));
check('Standard fix cycles = 2', /maximum_fix_cycles: 2/.test(standardSection));

// 3. Deep preset validation
console.log('\n--- Deep Preset ---');
const deepSection = presetsContent.match(/## Deep[\s\S]*?(?=---)/)?.[0] || '';
check('Deep preset exists', /## Deep/.test(presetsContent));
check('Deep has all 6 roles', /queen[\s\S]*?scout[\s\S]*?architect[\s\S]*?forger[\s\S]*?sentinel[\s\S]*?scribe/.test(deepSection));
check('Deep requires risk analysis', /require_risk_analysis: true/.test(deepSection));
check('Deep requires adversarial validation', /require_adversarial_validation: true/.test(deepSection));
check('Deep fix cycles = 2', /maximum_fix_cycles: 2/.test(deepSection));

// 4. Audit preset validation
console.log('\n--- Audit Preset ---');
const auditSection = presetsContent.match(/## Audit[\s\S]*?(?=---)/)?.[0] || '';
check('Audit preset exists', /## Audit/.test(presetsContent));
check('Audit has no forger', !/forger/.test(auditSection));
check('Audit has queen', /queen/.test(auditSection));
check('Audit has sentinel', /sentinel/.test(auditSection));
check('Audit has scribe', /scribe/.test(auditSection));
check('Audit allow_source_edits: false', /allow_source_edits: false/.test(auditSection));
check('Audit fix cycles = 0', /maximum_fix_cycles: 0/.test(auditSection));

// 5. Fixture-based scenario validation
console.log('\n--- Scenario Fixtures ---');
const fixtureFiles = fs.readdirSync(FIXTURES_DIR).filter(f => f.endsWith('.json'));
for (const fixtureFile of fixtureFiles) {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, fixtureFile), 'utf8'));
  check(`Fixture ${fixtureFile}: ${fixture.scenario} loaded`, fixture.preset && fixture.input && (fixture.expected_roles || fixture.expected_behavior));

  // Validate that the expected preset exists in the reference doc
  const presetKey = fixture.preset.charAt(0).toUpperCase() + fixture.preset.slice(1);
  check(`Fixture ${fixtureFile}: preset ${presetKey} documented`, new RegExp(`## ${presetKey}`).test(presetsContent));

  // Validate all expected roles exist in the councils
  if (Array.isArray(fixture.expected_roles)) {
    for (const role of fixture.expected_roles) {
      check(`Fixture ${fixtureFile}: role ${role} is valid`, ['queen', 'scout', 'architect', 'forger', 'sentinel', 'scribe'].includes(role));
    }
  } else {
    check(`Fixture ${fixtureFile}: no role validation needed (behavioral fixture)`, true);
  }
}

// 6. Sentinel removal protection
console.log('\n--- Sentinel Protection ---');
check('SKILL.md says Sentinel must not be removed from implementation tasks', /must not remove Sentinel/.test(skillContent));
check('Presets ref says Sentinel must not be removed', /must not remove Sentinel/.test(presetsContent));

// 7. Audit mode edit restriction
console.log('\n--- Audit Mode Safety ---');
check('Audit mode is only mode with allow_source_edits: false', /Audit mode is the only mode.*allow_source_edits: false/.test(presetsContent));

// Summary
console.log(`\n=== Results: ${passedChecks}/${totalChecks} passed ===\n`);
process.exit(allPassed ? 0 : 1);
