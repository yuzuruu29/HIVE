// The Hive Skill v0.2.1 — Handoff Schema Contract Test
// Validates that all role files use consistent handoff terminology
// No external dependencies required

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'hive-mind-council');

const REQUIRED_HANDOFF_STATUSES = ['complete', 'blocked', 'failed', 'needs_approval'];
const REQUIRED_CONFIDENCE_LABELS = ['high', 'medium', 'low'];
const REQUIRED_RUN_STATES = ['complete', 'partial', 'blocked', 'failed'];
const REQUIRED_PRESETS = ['quick', 'standard', 'deep', 'audit'];
const REQUIRED_VERDICTS = ['pass', 'pass_with_limitations', 'fail', 'blocked'];
const REQUIRED_PERMISSIONS = ['READ', 'WRITE', 'EXECUTE', 'NETWORK', 'GIT_MUTATE', 'DESTRUCTIVE'];

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function checkFileExists(p, label) {
  const exists = fs.existsSync(p);
  if (!exists) {
    console.error(`FAIL: ${label} — file not found: ${p}`);
  }
  return exists;
}

function checkContent(text, pattern, label) {
  const found = pattern.test(text);
  if (!found) {
    console.error(`FAIL: ${label} — pattern not found: ${pattern}`);
  } else {
    console.log(`PASS: ${label}`);
  }
  return found;
}

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

console.log('\n=== Handoff Schema Contract Tests ===\n');

// 1. All reference files exist
console.log('\n--- Reference Files ---');
const refFiles = [
  'council-protocol.md', 'role-contracts.md', 'handoff-schema.md',
  'orchestration-presets.md', 'verification-policy.md', 'safety-policy.md'
];
for (const f of refFiles) {
  check(`reference/${f} exists`, checkFileExists(path.join(SKILL_DIR, 'references', f), f));
}

// 2. All agent files exist
console.log('\n--- Agent Files ---');
const agentFiles = ['Queen.md', 'Scout.md', 'Architect.md', 'Forger.md', 'Sentinel.md', 'Scribe.md'];
for (const f of agentFiles) {
  check(`agents/${f} exists`, checkFileExists(path.join(SKILL_DIR, 'agents', f), f));
}

// 3. All template files exist
console.log('\n--- Template Files ---');
const templateFiles = [
  'run-contract.yaml', 'role-handoff.yaml', 'evidence-ledger.yaml', 'final-review.yaml',
  'council-loop.md', 'final-report.md', 'validation-report.md'
];
for (const f of templateFiles) {
  check(`templates/${f} exists`, checkFileExists(path.join(SKILL_DIR, 'templates', f), f));
}

// 4. All examples exist
console.log('\n--- Example Files ---');
const exampleFiles = ['bugfix.md', 'feature-build.md', 'refactor.md', 'test-generation.md'];
for (const f of exampleFiles) {
  check(`examples/${f} exists`, checkFileExists(path.join(SKILL_DIR, 'examples', f), f));
}

// 5. All adapters exist
console.log('\n--- Adapter Files ---');
const adapterDir = path.join(ROOT, 'adapters');
const adapterFiles = [
  'claude-code/README.md', 'claude-code/install.md',
  'codex/README.md', 'codex/AGENTS.md', 'codex/plugin.md',
  'opencode/README.md', 'opencode/install.md',
  'generic-agents/README.md', 'generic-agents/AGENTS.md'
];
for (const f of adapterFiles) {
  check(`adapters/${f} exists`, checkFileExists(path.join(adapterDir, f), f));
}

// 6. Validate SKILL.md contains required terminology
console.log('\n--- SKILL.md Terminology ---');
const skillContent = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
check('SKILL.md references Quick preset', /Quick/.test(skillContent));
check('SKILL.md references Standard preset', /Standard/.test(skillContent));
check('SKILL.md references Deep preset', /Deep/.test(skillContent));
check('SKILL.md references Audit preset', /Audit/.test(skillContent));
check('SKILL.md mentions stop conditions', /COMPLETE/.test(skillContent) && /BLOCKED/.test(skillContent) && /FAILED/.test(skillContent));
check('SKILL.md mentions Sentinel verdict', /Sentinel/.test(skillContent));
check('SKILL.md describes Sentinel validation', /across multiple layers/.test(skillContent));
check('SKILL.md mentions evidence rules', /evidence/i.test(skillContent));
check('SKILL.md mentions handoff', /handoff/i.test(skillContent));

// 7. Validate council-protocol.md
console.log('\n--- Council Protocol ---');
const protocolContent = fs.readFileSync(path.join(SKILL_DIR, 'references', 'council-protocol.md'), 'utf8');
check('Protocol has HIVE Run Contract', /HIVE Run Contract/.test(protocolContent));
check('Protocol has structured handoffs', /Structured Handoffs/.test(protocolContent));
check('Protocol has evidence ledger', /Evidence Ledger/.test(protocolContent));
check('Protocol has confidence labels', /Confidence Labels/.test(protocolContent));
check('Protocol has stop conditions', /Stop Conditions/.test(protocolContent));
check('Protocol has scope enforcement', /Scope Enforcement/.test(protocolContent));
check('Protocol has context budgeting', /Context Budgeting/.test(protocolContent));

// 8. Validate handoff schema
console.log('\n--- Handoff Schema ---');
const handoffContent = fs.readFileSync(path.join(SKILL_DIR, 'references', 'handoff-schema.md'), 'utf8');
check('Handoff schema has status field', /status/.test(handoffContent));
check('Handoff schema has findings field', /findings/.test(handoffContent));
check('Handoff schema has evidence field', /evidence/.test(handoffContent));
check('Handoff schema has confidence field', /confidence/.test(handoffContent));
check('Handoff schema has recommended_next_action', /recommended_next_action/.test(handoffContent));

// 9. Validate orchestration presets
console.log('\n--- Orchestration Presets ---');
const presetsContent = fs.readFileSync(path.join(SKILL_DIR, 'references', 'orchestration-presets.md'), 'utf8');
check('Quick preset has queen+forger+sentinel', /queen[\s\S]*?forger[\s\S]*?sentinel/.test(presetsContent));
check('Standard preset has all 6 roles', /queen[\s\S]*?scout[\s\S]*?architect[\s\S]*?forger[\s\S]*?sentinel[\s\S]*?scribe/.test(presetsContent));
check('Deep preset requires risk analysis', /require_risk_analysis: true/.test(presetsContent));
check('Deep preset requires adversarial validation', /require_adversarial_validation: true/.test(presetsContent));
check('Audit preset has allow_source_edits: false', /allow_source_edits: false/.test(presetsContent));
check('Audit preset does not include forger', !/forger/.test(presetsContent.match(/## Audit[\s\S]*?(?=##|$)/)?.[0] || ''));

// 10. Validate verification policy
console.log('\n--- Verification Policy ---');
const verifyContent = fs.readFileSync(path.join(SKILL_DIR, 'references', 'verification-policy.md'), 'utf8');
check('Has Layer 1: Static Validation', /Layer 1.*Static Validation/.test(verifyContent));
check('Has Layer 2: Automated Testing', /Layer 2.*Automated Testing/.test(verifyContent));
check('Has Layer 3: Behavioral Validation', /Layer 3.*Behavioral Validation/.test(verifyContent));
check('Has Layer 4: Safety Review', /Layer 4.*Safety Review/.test(verifyContent));
check('Has Layer 5: Portability Review', /Layer 5.*Portability Review/.test(verifyContent));
check('Has PASS verdict', /PASS/.test(verifyContent));
check('Has FAIL verdict', /FAIL/.test(verifyContent));
check('Has BLOCKED verdict', /BLOCKED/.test(verifyContent));
check('Has PASS WITH LIMITATIONS verdict', /PASS WITH LIMITATIONS/.test(verifyContent));
check('Has claim audit', /Claim Audit/.test(verifyContent));
check('Has adversarial scenarios', /Adversarial Scenarios/.test(verifyContent));

// 11. Validate safety policy
console.log('\n--- Safety Policy ---');
const safetyContent = fs.readFileSync(path.join(SKILL_DIR, 'references', 'safety-policy.md'), 'utf8');
for (const perm of REQUIRED_PERMISSIONS) {
  check(`Has ${perm} permission`, new RegExp(perm).test(safetyContent));
}
check('Has untrusted input policy', /Untrusted Input/.test(safetyContent));
check('Has file scope enforcement', /File Scope Enforcement/.test(safetyContent));
check('Has secret handling', /Secret Handling/.test(safetyContent));
check('Has user work protection', /User Work Protection/.test(safetyContent));
check('Has approval requirements', /Approval Requirements/.test(safetyContent));

// 12. Validate role contracts
console.log('\n--- Role Contracts ---');
const contractsContent = fs.readFileSync(path.join(SKILL_DIR, 'references', 'role-contracts.md'), 'utf8');
check('Queen has task classification', /Task classification/.test(contractsContent));
check('Scout has contradiction detection', /Contradiction detection/.test(contractsContent));
check('Architect has decision records', /Decision records/.test(contractsContent));
check('Forger has failure classification', /Failure classification/.test(contractsContent));
check('Sentinel has static validation capability', /Static validation/.test(contractsContent));
check('Sentinel has behavioral validation capability', /Behavioral validation/.test(contractsContent));
check('Sentinel has safety review capability', /Safety review/.test(contractsContent));
check('Sentinel has portability review capability', /Portability review/.test(contractsContent));
check('Sentinel has adversarial scenario testing', /Adversarial scenario testing/.test(contractsContent));
check('Sentinel has claim audit', /Claim audit/.test(contractsContent));
check('Scribe has documentation synchronization', /Documentation synchronization/.test(contractsContent));

// 13. Version consistency
console.log('\n--- Version Consistency ---');
const skillJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'skill.json'), 'utf8'));
const pluginJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'));
	check('skill.json version is 0.3.0', skillJson.version === '0.3.0');
		check('plugin.json version is 0.3.0', pluginJson.version === '0.3.0');
		check('README mentions v0.3.0', /v0\.3\.0/.test(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')));
		check('CHANGELOG has 0.2.1 section', /\[0\.2\.1\]/.test(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')));
		check('CHANGELOG has 0.3.0 section', /\[0\.3\.0\]/.test(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')));

	// 14. Validate no stale v0.1.0 references in active docs
	console.log('\n--- Stale Version Check ---');
	const activeDocs = [
	  'README.md', 'SKILL.md',
	  'adapters/claude-code/README.md', 'adapters/claude-code/install.md',
	  'adapters/codex/README.md', 'adapters/codex/AGENTS.md', 'adapters/codex/plugin.md',
	  'adapters/opencode/README.md', 'adapters/opencode/install.md',
	  'adapters/generic-agents/README.md', 'adapters/generic-agents/AGENTS.md'
	];
	let staleFound = false;
	for (const doc of activeDocs) {
	  const content = readFile(path.join(ROOT, doc));
	  if (content && /v0\.1\.0/.test(content)) {
	    console.error(`FAIL: ${doc} still contains v0.1.0 reference`);
	    staleFound = true;
	    allPassed = false;
	  }
	}
	if (!staleFound) {
	  console.log('PASS: No stale v0.1.0 references in active documentation');
	  passedChecks++;
	}
	totalChecks++;

	// ===== Phase 6: Anti-Overclaim Contract Tests =====

	// 15. Product Boundary Checks
	console.log('\n--- Product Boundary Checks ---');
	const whatThisIsPath = path.join(ROOT, 'WHAT_THIS_IS.md');
	const whatThisIsExists = fs.existsSync(whatThisIsPath);
	check('WHAT_THIS_IS.md exists', whatThisIsExists);

	const readmeContent = readFile(path.join(ROOT, 'README.md'));
	if (readmeContent) {
	  check('README.md links to WHAT_THIS_IS.md', /WHAT_THIS_IS\.md/.test(readmeContent));
	} else {
	  check('README.md links to WHAT_THIS_IS.md', false);
	}

	if (whatThisIsExists) {
	  const whatThisIsContent = fs.readFileSync(whatThisIsPath, 'utf8');
	  check('WHAT_THIS_IS.md calls the project a "protocol"', /\bprotocol\b/i.test(whatThisIsContent));
	  check('WHAT_THIS_IS.md says it is "not" a standalone runtime', /not[\s\S]{0,100}(standalone|runtime)/i.test(whatThisIsContent) || /(standalone|runtime)[\s\S]{0,100}not/i.test(whatThisIsContent));
	} else {
	  check('WHAT_THIS_IS.md calls the project a "protocol"', false);
	  check('WHAT_THIS_IS.md says it is "not" a standalone runtime', false);
	}

	// 16. Non-Goals Check
	console.log('\n--- Non-Goals Check ---');
	const skillContentText = readFile(path.join(SKILL_DIR, 'SKILL.md'));
	if (skillContentText) {
	  check('SKILL.md contains a "## Non-Goals" section', /##\s*Non-Goals/.test(skillContentText));
	} else {
	  check('SKILL.md contains a "## Non-Goals" section', false);
	}

	// 17. Adapter Disclosure Checks
	console.log('\n--- Adapter Disclosure Checks ---');
	const adapterReadmes = [
	  'claude-code/README.md',
	  'codex/README.md',
	  'opencode/README.md',
	  'generic-agents/README.md'
	];
	const disclosurePhrase = 'This adapter documents how the host runtime maps to the HIVE protocol';
	for (const relPath of adapterReadmes) {
	  const adapterContent = readFile(path.join(adapterDir, relPath));
	  if (adapterContent) {
	    check(`adapters/${relPath} contains protocol mapping disclosure`, adapterContent.includes(disclosurePhrase));
	  } else {
	    check(`adapters/${relPath} contains protocol mapping disclosure`, false);
	  }
	}

	// 18. Description Checks
	console.log('\n--- Description Checks ---');
	check('skill.json description uses protocol-oriented wording', /\bprotocol\b/i.test(skillJson.description));
	check('plugin.json description uses protocol-oriented wording', /\bprotocol\b/i.test(pluginJson.description));

	// 19. Banned Active Claims
	console.log('\n--- Banned Active Claims ---');

	const OVERCLAIMS = [
	  'guarantees multi-model execution',
	  'independent background daemon',
	  'works independently of the host runtime',
	  'six independent autonomous agents',
	  'guaranteed secure',
	  'production-ready without validation'
	];

	const scanFiles = [
	  'README.md',
	  'skills/hive-mind-council/SKILL.md',
	  'skill.json',
	  'plugin.json',
	  'package.json',
	  'adapters/claude-code/README.md',
	  'adapters/codex/README.md',
	  'adapters/opencode/README.md',
	  'adapters/generic-agents/README.md',
	  'marketplace/claude-plugin/README.md',
	  'marketplace/codex-plugin/README.md',
	  'marketplace/github-action/README.md',
	  'marketplace/claude-plugin/plugin.json',
	  'marketplace/codex-plugin/plugin.json'
	];

	/**
	 * Check whether a banned phrase appears in a non-negated context.
	 * Returns true if the phrase is absent, or present only inside negation.
	 */
	function phraseIsAcceptable(content, phrase) {
	  const idx = content.indexOf(phrase);
	  if (idx === -1) return true; // phrase not found — acceptable

	  // Look backward from the phrase to detect negation words
	  const lookback = 100;
	  const start = Math.max(0, idx - lookback);
	  const preceding = content.substring(start, idx);

	  // Negation patterns: the phrase should appear after a negation keyword
	  const negationPattern = /\b(does not|do not|is not|are not|was not|were not|will not|shall not|should not|cannot|can not|isn't|aren't|doesn't|don't|could not|would not|not)\b\s*$/i;

	  const match = preceding.match(negationPattern);
	  if (match) {
	    // Ensure "not" is a true negation, not a false positive like "notable"
	    const negationWord = match[1] || match[0];
	    if (/^not$/i.test(negationWord)) {
	      // For standalone "not", ensure it's used as a negation word, not part of another word
	      // Check the character before "not" is a non-word char or start
	      const notIdx = preceding.toLowerCase().lastIndexOf('not ');
	      const notEndIdx = preceding.toLowerCase().lastIndexOf('not');
	      if (notEndIdx >= 0) {
	        const charBefore = notEndIdx > 0 ? preceding[notEndIdx - 1] : ' ';
	        if (/\w/.test(charBefore)) {
	          // "not" is part of another word like "notable" — not a negation
	          return false;
	        }
	        return true;
	      }
	      return true;
	    }
	    return true; // negation found — acceptable
	  }

	  return false; // non-negated phrase found — NOT acceptable
	}

	let overclaimFailures = 0;
	for (const relPath of scanFiles) {
	  const fileContent = readFile(path.join(ROOT, relPath));
	  if (!fileContent) continue;

	  for (const phrase of OVERCLAIMS) {
	    const acceptable = phraseIsAcceptable(fileContent, phrase);
	    const label = `No "${phrase}" in ${relPath}`;
	    if (!acceptable) {
	      console.error(`FAIL: ${label} — phrase found in active (non-negated) context`);
	      overclaimFailures++;
	      allPassed = false;
	    } else {
	      // Only log PASS if the phrase was actually checked (exists but negated, or doesn't exist)
	      const idx = fileContent.indexOf(phrase);
	      if (idx !== -1) {
	        console.log(`PASS: ${label} (found only in negated context)`);
	      } else {
	        // Silent pass for phrases not present at all — avoid noise
	      }
	    }
	    totalChecks++;
	  }
	}
	if (overclaimFailures === 0) {
	  console.log('PASS: No banned overclaim phrases found in active (non-negated) context');
	  passedChecks += scanFiles.length * OVERCLAIMS.length - overclaimFailures;
	} else {
	  passedChecks += (scanFiles.length * OVERCLAIMS.length) - overclaimFailures;
	}

	// Summary
	console.log(`\n=== Results: ${passedChecks}/${totalChecks} passed ===\n`);
	process.exit(allPassed ? 0 : 1);
