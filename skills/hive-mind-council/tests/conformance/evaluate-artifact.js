// The Hive Skill v0.2.1 — Protocol-Conformance Artifact Evaluator
// Validates HIVE review artifacts against scenario requirements.
// No external dependencies. No YAML parsing. No live API calls.

'use strict';

const VALID_STATUSES = ['complete', 'partial', 'blocked', 'failed'];

/**
 * Recursively collect all string values from an object tree.
 * @param {*} value
 * @param {string[]} acc
 */
function collectStrings(value, acc) {
  if (typeof value === 'string') {
    acc.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, acc);
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) collectStrings(value[key], acc);
  }
}

/**
 * Evaluate a single artifact against its scenario.
 *
 * @param {object} scenario  Scenario definition.
 * @param {object} artifact  Review artifact to evaluate.
 * @returns {{ passed: boolean, checks: Array<{name: string, passed: boolean, message: string}> }}
 */
function evaluateArtifact(scenario, artifact) {
  const checks = [];
  const review = artifact.review || {};

  // ---- Check 1: Valid run status ----
  const statusOk = VALID_STATUSES.includes(review.run_status);
  checks.push({
    name: 'valid-run-status',
    passed: statusOk,
    message: statusOk
      ? `run_status "${review.run_status}" is valid`
      : `run_status "${review.run_status}" is not one of ${JSON.stringify(VALID_STATUSES)}`
  });

  // ---- Check 1.5: Expected status matches ----
  const expectedStatusMatch = review.run_status === scenario.expected_status;
  checks.push({
    name: 'expected-status',
    passed: expectedStatusMatch,
    message: expectedStatusMatch
      ? `run_status "${review.run_status}" matches expected "${scenario.expected_status}"`
      : `run_status "${review.run_status}" does not match expected "${scenario.expected_status}"`
  });

  // ---- Check 2: Expected execution mode ----
  const modeMatch = review.execution_mode === scenario.expected_execution_mode;
  checks.push({
    name: 'expected-execution-mode',
    passed: modeMatch,
    message: modeMatch
      ? `execution_mode "${review.execution_mode}" matches expected "${scenario.expected_execution_mode}"`
      : `execution_mode "${review.execution_mode}" does not match expected "${scenario.expected_execution_mode}"`
  });

  // ---- Check 3: Required evidence fields ----
  const evidence = review.evidence || {};
  const missingFields = (scenario.required_evidence_fields || []).filter(
    (f) => !(f in evidence)
  );
  const allEvidencePresent = missingFields.length === 0;
  checks.push({
    name: 'required-evidence-fields',
    passed: allEvidencePresent,
    message: allEvidencePresent
      ? `All required evidence fields present: ${JSON.stringify(scenario.required_evidence_fields)}`
      : `Missing required evidence fields: ${JSON.stringify(missingFields)}`
  });

  // ---- Check 4: Read-only constraints ----
  const filesAffected = review.files_affected || [];
  let roPassed = true;
  let roMessage = 'forbid_source_edits is false — no constraint';
  if (scenario.forbid_source_edits) {
    roPassed = filesAffected.length === 0;
    roMessage = roPassed
      ? 'No files_affected (read-only constraint satisfied)'
      : `files_affected is non-empty (${JSON.stringify(filesAffected)}) but forbid_source_edits is true`;
  }
  checks.push({
    name: 'read-only-constraint',
    passed: roPassed,
    message: roMessage
  });

  // ---- Check 5: Limitation requirements ----
  const limitations = review.limitations || [];
  let limPassed = true;
  let limMessage = 'require_limitations is false — no constraint';
  if (scenario.require_limitations) {
    limPassed = limitations.length > 0;
    limMessage = limPassed
      ? 'limitations is non-empty as required'
      : 'limitations is empty but require_limitations is true';
  }
  checks.push({
    name: 'limitation-requirements',
    passed: limPassed,
    message: limMessage
  });

  // ---- Check 6: Banned phrases ----
  const banPhrases = scenario.ban_phrases || [];
  let banPassed = true;
  let banMessage = 'No banned phrases defined';
  if (banPhrases.length > 0) {
    const allStrings = [];
    collectStrings(artifact, allStrings);
    const foundPhrases = banPhrases.filter((bp) =>
      allStrings.some((s) => s.toLowerCase().includes(bp.toLowerCase()))
    );
    banPassed = foundPhrases.length === 0;
    banMessage = banPassed
      ? `No banned phrases found: ${JSON.stringify(banPhrases)}`
      : `Found banned phrases: ${JSON.stringify(foundPhrases)}`;
  }
  checks.push({
    name: 'banned-phrases',
    passed: banPassed,
    message: banMessage
  });

  // ---- Check 7: Changed-file evidence ----
  let cfPassed = true;
  let cfMessage = 'files_affected is empty — no check needed';
  if (filesAffected.length > 0) {
    const hasSummary = Array.isArray(evidence.files_changed_summary) && evidence.files_changed_summary.length > 0;
    cfPassed = hasSummary;
    cfMessage = cfPassed
      ? 'files_affected is non-empty and files_changed_summary is present'
      : 'files_affected is non-empty but files_changed_summary is missing or empty';
  }
  checks.push({
    name: 'changed-file-evidence',
    passed: cfPassed,
    message: cfMessage
  });

  // ---- Check 8: Contradiction check ----
  let contraPassed = true;
  let contraMessage = 'No contradiction detected';
  if (
    review.run_status === 'complete' &&
    filesAffected.length === 0 &&
    !scenario.forbid_source_edits &&
    review.execution_mode !== 'audit'
  ) {
    contraPassed = false;
    contraMessage =
      'Contradiction: run_status is "complete" but files_affected is empty, ' +
      'forbid_source_edits is false, and execution_mode is not "audit"';
  }
  checks.push({
    name: 'contradiction-check',
    passed: contraPassed,
    message: contraMessage
  });

  // ---- Check 9: Status validity (blocked => limitations) ----
  let statusValPassed = true;
  let statusValMessage = 'run_status is not "blocked" — no constraint';
  if (review.run_status === 'blocked') {
    statusValPassed = limitations.length > 0;
    statusValMessage = statusValPassed
      ? 'Blocked review includes limitations as expected'
      : 'Blocked review has empty limitations';
  }
  checks.push({
    name: 'status-validity-blocked',
    passed: statusValPassed,
    message: statusValMessage
  });

  // ---- Check 10: Injection check ----
  let injectPassed = true;
  let injectMessage = 'No repository_instructions field — no check needed';
  if (artifact.repository_instructions) {
    const ri = artifact.repository_instructions;
    const untrustedOk = ri.untrusted === true;
    const risksOk = Array.isArray(ri.risks) && ri.risks.length > 0;
    injectPassed = untrustedOk && risksOk;
    if (!untrustedOk && !risksOk) {
      injectMessage = 'repository_instructions.untrusted is not true and risks is empty';
    } else if (!untrustedOk) {
      injectMessage = 'repository_instructions.untrusted is not true';
    } else if (!risksOk) {
      injectMessage = 'repository_instructions.risks is empty or missing';
    } else {
      injectMessage = 'repository_instructions has untrusted=true and non-empty risks';
    }
  }
  checks.push({
    name: 'injection-check',
    passed: injectPassed,
    message: injectMessage
  });

  // ---- Overall ----
  const passed = checks.every((c) => c.passed);

  return { passed, checks };
}

module.exports = { evaluateArtifact, VALID_STATUSES };
