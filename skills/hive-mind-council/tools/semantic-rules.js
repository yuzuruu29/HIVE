/**
 * semantic-rules.js — Semantic validation rules for HIVE Protocol artifacts
 *
 * Rules that JSON Schema cannot express. Each function checks a single rule
 * and returns zero or more error objects. The validateSemantics() function
 * dispatches rules based on artifact type and optional context.
 *
 * Each error has the shape: { rule, message, path }
 *   rule  — short machine-readable rule identifier
 *   message — human-readable description of the problem
 *   path  — JSON Pointer-like path to the relevant location (or '')
 */

'use strict';

// -------------------------------------------------------------------------
// Helper
// -------------------------------------------------------------------------

function semverGte(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) {
      return (pa[i] || 0) > (pb[i] || 0);
    }
  }
  return true; // equal
}

function semverLt(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) {
      return (pa[i] || 0) < (pb[i] || 0);
    }
  }
  return false; // equal
}

// -------------------------------------------------------------------------
// Individual semantic rule checks
// -------------------------------------------------------------------------

/**
 * Rule 1: audit-no-source-edits
 * If execution_mode is "audit" and files_affected is non-empty, error.
 */
function ruleAuditNoSourceEdits(data) {
  const errors = [];
  if (data.execution_mode === 'audit' && Array.isArray(data.files_affected) && data.files_affected.length > 0) {
    errors.push({
      rule: 'audit-no-source-edits',
      message: 'Audit mode must not have source edits, but files_affected is non-empty.',
      path: '/files_affected',
    });
  }
  return errors;
}

/**
 * Rule 2: audit-no-forger
 * If type is "task-graph", check no task has assigned_role "forger"
 * when the execution context is audit.
 */
function ruleAuditNoForger(data) {
  const errors = [];
  if (data.execution_mode === 'audit' && Array.isArray(data.tasks)) {
    for (let i = 0; i < data.tasks.length; i++) {
      if (data.tasks[i].assigned_role === 'forger') {
        errors.push({
          rule: 'audit-no-forger',
          message: `Audit mode must not have tasks assigned to "forger" role, but task "${data.tasks[i].task_id || i}" has assigned_role "forger".`,
          path: `/tasks/${i}/assigned_role`,
        });
      }
    }
  }
  return errors;
}

/**
 * Rule 3: implementation-needs-sentinel
 * If type is "task-graph" and NOT audit mode, ensure at least one task
 * has assigned_role "sentinel".
 */
function ruleImplementationNeedsSentinel(data) {
  const errors = [];
  if (data.execution_mode !== 'audit' && Array.isArray(data.tasks)) {
    const hasSentinel = data.tasks.some(t => t.assigned_role === 'sentinel');
    if (!hasSentinel) {
      errors.push({
        rule: 'implementation-needs-sentinel',
        message: 'Non-audit execution modes require at least one task with assigned_role "sentinel", but none found.',
        path: '/tasks',
      });
    }
  }
  return errors;
}

/**
 * Rule 4: fix-cycles-within-preset
 * Validate fix_cycles_used against execution_mode limits.
 *   quick    <= 1
 *   standard <= 2
 *   deep     <= 2
 *   audit    == 0
 */
function ruleFixCyclesWithinPreset(data) {
  const errors = [];
  if (data.fix_cycles_used === undefined) return errors;
  const maxCycles = { quick: 1, standard: 2, deep: 2, audit: 0 };
  const max = maxCycles[data.execution_mode];
  if (max === undefined) return errors; // unknown mode
  if (data.fix_cycles_used > max) {
    errors.push({
      rule: 'fix-cycles-within-preset',
      message: `Execution mode "${data.execution_mode}" allows at most ${max} fix cycle(s), but fix_cycles_used is ${data.fix_cycles_used}.`,
      path: '/fix_cycles_used',
    });
  }
  return errors;
}

/**
 * Rule 5: complete-no-fail-verdict
 * If run_status is "complete" and sentinel_verdict is "FAIL" or "BLOCKED", error.
 */
function ruleCompleteNoFailVerdict(data) {
  const errors = [];
  if (data.run_status === 'complete') {
    if (data.sentinel_verdict === 'FAIL' || data.sentinel_verdict === 'BLOCKED') {
      errors.push({
        rule: 'complete-no-fail-verdict',
        message: `Run status is "complete" but sentinel_verdict is "${data.sentinel_verdict}". A complete run must not have a failing verdict.`,
        path: '/sentinel_verdict',
      });
    }
  }
  return errors;
}

/**
 * Rule 6: pass-no-critical-findings
 * If sentinel_verdict is "PASS" but there are unresolved critical findings, error.
 *
 * Critical findings are determined by findings with severity "high" or
 * (in role-handoff) that have confidence "high" and describe critical issues.
 */
function rulePassNoCriticalFindings(data) {
  const errors = [];
  if (data.sentinel_verdict === 'PASS' || data.sentinel_verdict === 'PASS_WITH_LIMITATIONS') {
    const criticalFindings = [];
    // Check role-handoff findings
    if (Array.isArray(data.findings)) {
      for (let i = 0; i < data.findings.length; i++) {
        const f = data.findings[i];
        if (f.confidence === 'high' || f.severity === 'high') {
          criticalFindings.push(`/findings/${i}`);
        }
      }
    }
    // Check risks
    if (Array.isArray(data.risks)) {
      for (let i = 0; i < data.risks.length; i++) {
        if (data.risks[i].severity === 'high') {
          criticalFindings.push(`/risks/${i}`);
        }
      }
    }
    if (criticalFindings.length > 0) {
      errors.push({
        rule: 'pass-no-critical-findings',
        message: `Sentinel verdict is "${data.sentinel_verdict}" but there are ${criticalFindings.length} unresolved critical finding(s) at: ${criticalFindings.join(', ')}.`,
        path: '/',
      });
    }
  }
  return errors;
}

/**
 * Rule 7: evidence-refs-exist
 * All evidence_refs values must reference existing evidence entries
 * (if evidence ledger is available via context).
 */
function ruleEvidenceRefsExist(data, context) {
  const errors = [];
  const evidenceIds = (context && context.evidenceIds) || [];
  if (evidenceIds.length === 0) return errors; // no context — skip

  const refs = collectEvidenceRefs(data);
  for (const ref of refs) {
    if (!evidenceIds.includes(ref)) {
      errors.push({
        rule: 'evidence-refs-exist',
        message: `Evidence reference "${ref}" does not match any evidence entry in the ledger.`,
        path: '/evidence_refs',
      });
    }
  }
  return errors;
}

/** Recursively collect all evidence_refs values from an artifact. */
function collectEvidenceRefs(obj, refs) {
  refs = refs || [];
  if (!obj || typeof obj !== 'object') return refs;
  if (Array.isArray(obj)) {
    for (const item of obj) collectEvidenceRefs(item, refs);
  } else {
    if (Array.isArray(obj.evidence_refs)) {
      for (const ref of obj.evidence_refs) {
        if (typeof ref === 'string') refs.push(ref);
      }
    }
    for (const key of Object.keys(obj)) {
      if (key !== 'evidence_refs') {
        collectEvidenceRefs(obj[key], refs);
      }
    }
  }
  return refs;
}

/**
 * Rule 8: test-claims-need-evidence
 * If changes includes "tests" or verification mentions tests,
 * must have at least one command or test evidence entry.
 */
function ruleTestClaimsNeedEvidence(data) {
  const errors = [];
  const mentionsTests = (
    (Array.isArray(data.changes) && data.changes.some(c => /test/i.test(c))) ||
    (Array.isArray(data.verification) && data.verification.some(v => /test/i.test(v)))
  );
  if (!mentionsTests) return errors;

  // Check evidence in the same artifact
  const hasTestEvidence = (
    (Array.isArray(data.evidence) && data.evidence.some(e => e.type === 'command' || e.type === 'test')) ||
    (Array.isArray(data.commands_run) && data.commands_run.length > 0)
  );
  if (!hasTestEvidence) {
    errors.push({
      rule: 'test-claims-need-evidence',
      message: 'Changes or verification mention tests, but no command or test evidence entries are present.',
      path: '/evidence',
    });
  }
  return errors;
}

/**
 * Rule 9: dependencies-reference-real-tasks
 * If type is "task-graph", all dependency IDs must match existing task IDs.
 */
function ruleDependenciesReferenceRealTasks(data) {
  const errors = [];
  if (!Array.isArray(data.tasks)) return errors;
  const taskIds = new Set(data.tasks.map(t => t.task_id));
  for (let i = 0; i < data.tasks.length; i++) {
    const deps = data.tasks[i].dependencies;
    if (Array.isArray(deps)) {
      for (let j = 0; j < deps.length; j++) {
        if (!taskIds.has(deps[j])) {
          errors.push({
            rule: 'dependencies-reference-real-tasks',
            message: `Task "${data.tasks[i].task_id}" depends on "${deps[j]}", but no task with that ID exists in the graph.`,
            path: `/tasks/${i}/dependencies/${j}`,
          });
        }
      }
    }
  }
  return errors;
}

/**
 * Rule 10: no-cyclic-dependencies
 * If type is "task-graph", detect circular dependencies between tasks.
 */
function ruleNoCyclicDependencies(data) {
  const errors = [];
  if (!Array.isArray(data.tasks)) return errors;

  const taskMap = {};
  for (const t of data.tasks) {
    taskMap[t.task_id] = t;
  }

  const visited = new Set();
  const inStack = new Set();

  function detectCycle(taskId, path) {
    if (inStack.has(taskId)) {
      const cycleStart = path.indexOf(taskId);
      const cycle = path.slice(cycleStart).concat(taskId);
      return cycle;
    }
    if (visited.has(taskId)) return null;
    visited.add(taskId);
    inStack.add(taskId);
    const task = taskMap[taskId];
    if (task && Array.isArray(task.dependencies)) {
      for (const dep of task.dependencies) {
        if (taskMap[dep]) {
          const cycle = detectCycle(dep, path.concat(taskId));
          if (cycle) return cycle;
        }
      }
    }
    inStack.delete(taskId);
    return null;
  }

  for (const t of data.tasks) {
    const cycle = detectCycle(t.task_id, []);
    if (cycle) {
      errors.push({
        rule: 'no-cyclic-dependencies',
        message: `Circular dependency detected: ${cycle.join(' -> ')}.`,
        path: '/tasks',
      });
      break; // one cycle error is enough per run
    }
  }
  return errors;
}

/**
 * Rule 11: shared-run-id
 * If multiple artifacts are being validated together (via context),
 * all must share the same run_id.
 * (Partial implementation — works with single artifact but has
 *  hooks for bundle-level validation.)
 */
function ruleSharedRunId(data, context) {
  const errors = [];
  const expectedRunId = (context && context.expectedRunId);
  if (expectedRunId && data.run_id && data.run_id !== expectedRunId) {
    errors.push({
      rule: 'shared-run-id',
      message: `Expected run_id "${expectedRunId}" but artifact has run_id "${data.run_id}".`,
      path: '/run_id',
    });
  }
  return errors;
}

/**
 * Rule 12: compatible-protocol-versions
 * Protocol version must be >= "1.0.0" and < "2.0.0".
 */
function ruleCompatibleProtocolVersions(data) {
  const errors = [];
  const pv = data.protocol_version;
  if (pv) {
    if (!semverGte(pv, '1.0.0')) {
      errors.push({
        rule: 'compatible-protocol-versions',
        message: `Protocol version "${pv}" is less than minimum supported version "1.0.0".`,
        path: '/protocol_version',
      });
    }
    if (!semverLt(pv, '2.0.0')) {
      errors.push({
        rule: 'compatible-protocol-versions',
        message: `Protocol version "${pv}" is >= "2.0.0". Only protocol versions in the 1.x range are supported.`,
        path: '/protocol_version',
      });
    }
  }
  return errors;
}

/**
 * Rule 13: secret-scanning
 * Scan artifact for patterns: "sk-", "Bearer ", "BEGIN PRIVATE KEY",
 * "AWS_SECRET_ACCESS_KEY", "password=", "api_key=".
 * Produces warnings by default (rule has prefix "warn:").
 */
function ruleSecretScanning(data) {
  const errors = [];
  const patterns = [
    { pattern: /sk-[A-Za-z0-9_-]{8,}/g, label: 'API key (sk-)' },
    { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+/g, label: 'Bearer token' },
    { pattern: /BEGIN\s+PRIVATE\s+KEY/g, label: 'Private key block' },
    { pattern: /AWS_SECRET_ACCESS_KEY/g, label: 'AWS secret access key' },
    { pattern: /password=/g, label: 'Password parameter' },
    { pattern: /api_key=/g, label: 'API key parameter' },
  ];

  scanValue(data, patterns, errors, '');
  return errors;
}

function scanValue(value, patterns, errors, path) {
  if (typeof value === 'string') {
    for (const { pattern, label } of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(value)) {
        errors.push({
          rule: 'warn:secret-scanning',
          message: `Possible secret detected: matches "${label}" pattern. Review before committing.`,
          path: path || '',
        });
      }
    }
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanValue(value[i], patterns, errors, `${path}/${i}`);
    }
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      scanValue(value[key], patterns, errors, `${path}/${key}`);
    }
  }
}

// -------------------------------------------------------------------------
// Rule dispatch
// -------------------------------------------------------------------------

const RULES_BY_TYPE = {
  'run-contract': [
    ruleCompatibleProtocolVersions,
    ruleSecretScanning,
    ruleSharedRunId,
  ],
  'task-graph': [
    ruleAuditNoForger,
    ruleImplementationNeedsSentinel,
    ruleDependenciesReferenceRealTasks,
    ruleNoCyclicDependencies,
    ruleCompatibleProtocolVersions,
    ruleSecretScanning,
    ruleSharedRunId,
  ],
  'role-handoff': [
    rulePassNoCriticalFindings,
    ruleEvidenceRefsExist,
    ruleCompatibleProtocolVersions,
    ruleSecretScanning,
    ruleSharedRunId,
  ],
  'evidence-ledger': [
    ruleCompatibleProtocolVersions,
    ruleSecretScanning,
    ruleSharedRunId,
  ],
  'final-review': [
    ruleAuditNoSourceEdits,
    ruleFixCyclesWithinPreset,
    ruleCompleteNoFailVerdict,
    rulePassNoCriticalFindings,
    ruleTestClaimsNeedEvidence,
    ruleCompatibleProtocolVersions,
    ruleSecretScanning,
    ruleSharedRunId,
  ],
  'runtime-capabilities': [
    ruleCompatibleProtocolVersions, // though runtime-capabilities has protocol_versions, not protocol_version
    ruleSecretScanning,
  ],
  'adapter-manifest': [
    ruleCompatibleProtocolVersions,
    ruleSecretScanning,
  ],
  'run-manifest': [
    ruleCompatibleProtocolVersions,
    ruleSecretScanning,
    ruleSharedRunId,
  ],
  'protocol-manifest': [
    ruleCompatibleProtocolVersions,
    ruleSecretScanning,
  ],
};

const RULES_ALL = [
  ruleSecretScanning,
];

// -------------------------------------------------------------------------
// Exported API
// -------------------------------------------------------------------------

/**
 * Run all applicable semantic rules for an artifact.
 *
 * @param {string} type      — Artifact type name
 * @param {object} data      — Parsed JSON artifact
 * @param {object} [context] — Optional context (e.g. { evidenceIds, expectedRunId })
 * @returns {Array<{ rule: string, message: string, path: string }>}
 */
function validateSemantics(type, data, context) {
  const errors = [];
  const rules = RULES_BY_TYPE[type] || RULES_ALL;

  for (const ruleFn of rules) {
    try {
      const result = ruleFn(data, context);
      if (Array.isArray(result)) {
        errors.push(...result);
      }
    } catch (err) {
      errors.push({
        rule: 'internal-error',
        message: `Semantic rule "${ruleFn.name}" threw an error: ${err.message}`,
        path: '',
      });
    }
  }

  return errors;
}

module.exports = { validateSemantics };
