#!/usr/bin/env node

/**
 * hive-validate.js — HIVE Protocol Artifact Validation CLI
 *
 * Validates HIVE protocol artifacts against JSON Schemas and semantic rules.
 *
 * Usage:
 *   node tools/hive-validate.js --type <type> --file <path>
 *   node tools/hive-validate.js --bundle <path>
 *   node tools/hive-validate.js --adapter <path>
 *
 * Exit codes:
 *   0  — valid
 *   1  — schema or semantic validation failed
 *   2  — invalid CLI usage
 *   3  — file or schema could not be loaded
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { validateArtifact } = require('./load-schema');
const { validateSemantics } = require('./semantic-rules');

// ---------------------------------------------------------------------------
// Help / usage
// ---------------------------------------------------------------------------

const USAGE = `
Usage:
  node tools/hive-validate.js --type <artifact-type> --file <json-file>
  node tools/hive-validate.js --bundle <.hive-run-directory>
  node tools/hive-validate.js --adapter <adapter-manifest-file>

Options:
  --type <type>    Artifact type (run-contract, task-graph, role-handoff,
                   evidence-ledger, final-review, runtime-capabilities,
                   adapter-manifest, run-manifest, protocol-manifest)
  --file <path>    Path to the JSON artifact file
  --bundle <path>  Path to a .hive-run directory (validates all artifacts)
  --adapter <path> Path to an adapter manifest JSON file
  --json           Output results in machine-readable JSON format
  --help           Show this help message

Exit codes:
  0  — All validations passed
  1  — Schema or semantic validation failed
  2  — Invalid CLI usage
  3  — File or schema could not be loaded

Examples:
  node tools/hive-validate.js --type final-review --file final-review.json
  node tools/hive-validate.js --bundle .hive-run
  node tools/hive-validate.js --adapter adapters/my-adapter/adapter.json
  node tools/hive-validate.js --type protocol-manifest --file protocol.json --json
`;

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/**
 * Format a single Ajv error object into a human-readable string.
 */
function formatAjvError(err) {
  const schemaPath = err.schemaPath || '';
  const message = err.message || 'unknown error';
  const instancePath = err.instancePath || '';
  if (instancePath) {
    return `${instancePath} ${message}`;
  }
  if (err.params && err.params.allowedValues) {
    return `${schemaPath} must be one of: ${err.params.allowedValues.join(', ')}`;
  }
  return `${schemaPath || '(root)'} ${message}`;
}

/**
 * Format a semantic error object into a human-readable string.
 */
function formatSemanticError(err) {
  const prefix = err.rule ? `[${err.rule}]` : '';
  return `${prefix} ${err.message}`;
}

function printHumanResult(result) {
  if (result.valid) {
    console.log(`PASS: ${result.label || result.file} conforms to HIVE Protocol 1.0.0`);
  } else {
    console.log(`FAIL: ${result.label || result.file}\n`);
    if (result.schema_errors && result.schema_errors.length > 0) {
      console.log('Schema errors:');
      for (const err of result.schema_errors) {
        console.log(`- ${formatAjvError(err)}`);
      }
      console.log();
    }
    if (result.semantic_errors && result.semantic_errors.length > 0) {
      console.log('Semantic errors:');
      for (const err of result.semantic_errors) {
        console.log(`- ${formatSemanticError(err)}`);
      }
      console.log();
    }
  }
}

function printJsonResult(result) {
  const output = {
    valid: result.valid,
    artifact_type: result.artifact_type || null,
    protocol_version: result.protocol_version || null,
    schema_errors: result.schema_errors || [],
    semantic_errors: result.semantic_errors || [],
  };
  console.log(JSON.stringify(output, null, 2));
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------

function loadJsonFile(filePath) {
  try {
    const resolved = path.resolve(filePath);
    const raw = fs.readFileSync(resolved, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to load file "${filePath}": ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Single artifact validation
// ---------------------------------------------------------------------------

function validateSingle(type, filePath, artifactType) {
  const data = loadJsonFile(filePath);

  // Schema validation
  const schemaResult = validateArtifact(type, data);

  // Semantic validation — collect evidenceIds if data is an evidence ledger
  const context = {};
  if (type === 'evidence-ledger' && Array.isArray(data.evidence)) {
    context.evidenceIds = data.evidence.map(e => e.evidence_id);
  }

  const semanticErrors = validateSemantics(type, data, context);

  const allErrors = [...schemaResult.errors, ...semanticErrors];
  const valid = schemaResult.valid && semanticErrors.length === 0;

  return {
    valid,
    label: path.basename(filePath),
    file: filePath,
    artifact_type: artifactType || type,
    protocol_version: data.protocol_version || null,
    schema_errors: schemaResult.valid ? [] : schemaResult.errors,
    semantic_errors: semanticErrors,
  };
}

// ---------------------------------------------------------------------------
// Bundle validation (.hive-run)
// ---------------------------------------------------------------------------

/**
 * Infer artifact type from file path relative to the bundle root.
 * Maps known path patterns to HIVE artifact types.
 */
function inferTypeFromPath(relativePath) {
  const basename = path.basename(relativePath);
  const dirname = path.dirname(relativePath);

  if (basename === 'manifest.json') return 'run-manifest';
  if (basename === 'run-contract.json') return 'run-contract';
  if (basename === 'runtime-capabilities.json') return 'runtime-capabilities';
  if (basename === 'task-graph.json') return 'task-graph';
  if (basename === 'final-review.json') return 'final-review';
  if (dirname.startsWith('handoffs') && basename.endsWith('.json')) return 'role-handoff';
  if (dirname.startsWith('evidence') && basename.endsWith('.json')) return 'evidence-ledger';

  return null;
}

/**
 * Check for path traversal attempts in a relative path string.
 * Returns an error message if traversal is detected, or null if safe.
 */
function checkPathTraversal(relativePath) {
  const normalized = path.normalize(relativePath).replace(/\\/g, '/');
  if (normalized.includes('..')) {
    return `Path traversal detected: "${relativePath}" contains ".."`;
  }
  if (path.isAbsolute(relativePath)) {
    return `Path traversal detected: "${relativePath}" is an absolute path`;
  }
  return null;
}

/**
 * Recursively collect all string values from an object for secret scanning.
 */
function collectAllStrings(obj, strings) {
  strings = strings || [];
  if (typeof obj === 'string') {
    strings.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) collectAllStrings(item, strings);
  } else if (obj && typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      collectAllStrings(obj[key], strings);
    }
  }
  return strings;
}

/**
 * Run secret scanning on all text content of an artifact.
 * Returns an array of warning objects.
 */
function scanArtifactForSecrets(data) {
  if (!data || typeof data !== 'object') return [];
  const patterns = [
    { pattern: /sk-[A-Za-z0-9_-]{8,}/g, label: 'API key (sk-)' },
    { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+/g, label: 'Bearer token' },
    { pattern: /BEGIN\s+PRIVATE\s+KEY/g, label: 'Private key block' },
    { pattern: /AWS_SECRET_ACCESS_KEY/g, label: 'AWS secret access key' },
    { pattern: /password=/g, label: 'Password parameter' },
    { pattern: /api_key=/g, label: 'API key parameter' },
  ];

  const allStrings = collectAllStrings(data);
  const warnings = [];

  for (const str of allStrings) {
    for (const { pattern, label } of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(str)) {
        warnings.push({
          rule: 'warn:secret-scanning',
          message: `Possible secret detected: matches "${label}" pattern. Review before committing.`,
          path: '',
        });
        break; // one warning per string
      }
    }
  }

  return warnings;
}

function validateBundle(bundleDir) {
  const resolvedDir = path.resolve(bundleDir);
  const manifestPath = path.join(resolvedDir, 'manifest.json');

  let manifest;
  try {
    manifest = loadJsonFile(manifestPath);
  } catch (err) {
    throw new Error(`Could not load bundle manifest at "${manifestPath}": ${err.message}`);
  }

  // Validate the manifest itself
  const results = [];
  const manifestResult = validateSingle('run-manifest', manifestPath, 'run-manifest');
  results.push(manifestResult);

  // Collect all run_ids for shared-run-id check
  const runIds = [];
  if (manifest.run_id) runIds.push(manifest.run_id);

  // Check for path traversal in artifact_index entries
  const artifactIndex = manifest.artifact_index || [];
  for (const entry of artifactIndex) {
    const traversalError = checkPathTraversal(entry.path);
    if (traversalError) {
      results.push({
        valid: false,
        label: entry.path,
        file: path.join(resolvedDir, entry.path),
        artifact_type: null,
        protocol_version: null,
        schema_errors: [{ message: traversalError }],
        semantic_errors: [],
      });
      continue;
    }
  }

  // Validate each artifact in the index
  for (const entry of artifactIndex) {
    // Skip if a traversal error was already reported
    if (checkPathTraversal(entry.path)) continue;

    const artifactPath = path.resolve(resolvedDir, entry.path);
    try {
      const artifactData = loadJsonFile(artifactPath);
      if (artifactData.run_id) runIds.push(artifactData.run_id);

      // Infer type from path first, fall back to structural detection
      let determinedType = inferTypeFromPath(entry.path);
      if (!determinedType) {
        determinedType = detectArtifactType(artifactData);
      }

      if (determinedType) {
        const schemaResult = validateArtifact(determinedType, artifactData);
        const context = {
          expectedRunId: manifest.run_id,
        };
        if (determinedType === 'evidence-ledger' && Array.isArray(artifactData.evidence)) {
          context.evidenceIds = artifactData.evidence.map(e => e.evidence_id);
        }
        const semanticErrors = validateSemantics(determinedType, artifactData, context);

        // Run standalone secret scanning as an additional check
        const secretWarnings = scanArtifactForSecrets(artifactData);

        const allErrors = [...schemaResult.errors, ...semanticErrors, ...secretWarnings];
        const allSemanticErrors = [...semanticErrors, ...secretWarnings];
        const valid = schemaResult.valid && allSemanticErrors.length === 0;

        results.push({
          valid,
          label: entry.path,
          file: artifactPath,
          artifact_type: determinedType,
          protocol_version: artifactData.protocol_version || null,
          schema_errors: schemaResult.valid ? [] : schemaResult.errors,
          semantic_errors: allSemanticErrors,
        });
      } else {
        results.push({
          valid: false,
          label: entry.path,
          file: artifactPath,
          artifact_type: null,
          protocol_version: null,
          schema_errors: [{ message: 'Could not determine artifact type from structure or path' }],
          semantic_errors: [],
        });
      }
    } catch (err) {
      results.push({
        valid: false,
        label: entry.path,
        file: artifactPath,
        artifact_type: null,
        protocol_version: null,
        schema_errors: [{ message: `Could not load artifact: ${err.message}` }],
        semantic_errors: [],
      });
    }
  }

  // Check that all artifacts share one run_id
  if (runIds.length > 1) {
    const uniqueRunIds = [...new Set(runIds)];
    if (uniqueRunIds.length > 1) {
      results.push({
        valid: false,
        label: 'run_id consistency',
        file: manifestPath,
        artifact_type: 'bundle',
        protocol_version: null,
        schema_errors: [],
        semantic_errors: [{
          rule: 'shared-run-id',
          message: `Bundle artifacts have mismatched run_ids: ${uniqueRunIds.join(', ')}. All artifacts must share the same run_id.`,
        }],
      });
    }
  }

  // Aggregate: all must be valid for the bundle to be valid
  const valid = results.every(r => r.valid);

  return {
    valid,
    label: `${path.basename(resolvedDir)}/`,
    file: manifestPath,
    artifact_type: 'bundle',
    protocol_version: manifest.protocol_version || null,
    results,
    schema_errors: [],
    semantic_errors: [],
  };
}

/**
 * Attempt to detect the artifact type from its JSON structure.
 */
function detectArtifactType(data) {
  if (!data || typeof data !== 'object') return null;

  // Check for direct type indicators
  if (data.name === 'hive-mind-council') return 'protocol-manifest';
  if (data.adapter && data.declared_conformance_level !== undefined) return 'adapter-manifest';
  if (data.runtime && data.capabilities && data.limits) return 'runtime-capabilities';
  if (data.bundle_version && data.artifact_index) return 'run-manifest';
  if (data.tasks && Array.isArray(data.tasks)) return 'task-graph';
  if (data.evidence && Array.isArray(data.evidence)) return 'evidence-ledger';
  if (data.role && data.task_id && data.findings) return 'role-handoff';
  if (data.run_status && data.sentinel_verdict && data.result) return 'final-review';
  if (data.goal && data.deliverables && data.execution_mode !== undefined && data.maximum_fix_cycles !== undefined) return 'run-contract';

  return null;
}

// ---------------------------------------------------------------------------
// Adapter validation
// ---------------------------------------------------------------------------

function validateAdapter(adapterPath) {
  const data = loadJsonFile(adapterPath);

  // Schema validation
  const schemaResult = validateArtifact('adapter-manifest', data);

  // Semantic validation
  const semanticErrors = validateSemantics('adapter-manifest', data);

  const valid = schemaResult.valid && semanticErrors.length === 0;

  return {
    valid,
    label: path.basename(adapterPath),
    file: adapterPath,
    artifact_type: 'adapter-manifest',
    protocol_version: data.protocol_version || null,
    schema_errors: schemaResult.valid ? [] : schemaResult.errors,
    semantic_errors: semanticErrors,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  // --help
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const typeIndex = args.indexOf('--type');
  const fileIndex = args.indexOf('--file');
  const bundleIndex = args.indexOf('--bundle');
  const adapterIndex = args.indexOf('--adapter');
  const jsonFlag = args.includes('--json');

  // Count how many modes are selected
  const modes = [
    typeIndex !== -1 && fileIndex !== -1 ? 'single' : null,
    bundleIndex !== -1 ? 'bundle' : null,
    adapterIndex !== -1 ? 'adapter' : null,
  ].filter(Boolean);

  if (modes.length === 0) {
    console.error('ERROR: Specify one of: --type + --file, --bundle, or --adapter');
    console.error(USAGE);
    process.exit(2);
  }

  if (modes.length > 1) {
    console.error('ERROR: Use only one mode at a time (--type+--file, --bundle, or --adapter).');
    process.exit(2);
  }

  try {
    let result;

    if (modes[0] === 'single') {
      const type = args[typeIndex + 1];
      const file = args[fileIndex + 1];
      if (!type || type.startsWith('-')) {
        console.error('ERROR: --type requires a value.');
        process.exit(2);
      }
      if (!file || file.startsWith('-')) {
        console.error('ERROR: --file requires a value.');
        process.exit(2);
      }
      result = validateSingle(type, file, type);
    } else if (modes[0] === 'bundle') {
      const bundlePath = args[bundleIndex + 1];
      if (!bundlePath || bundlePath.startsWith('-')) {
        console.error('ERROR: --bundle requires a value.');
        process.exit(2);
      }
      result = validateBundle(bundlePath);
    } else if (modes[0] === 'adapter') {
      const adapterPath = args[adapterIndex + 1];
      if (!adapterPath || adapterPath.startsWith('-')) {
        console.error('ERROR: --adapter requires a value.');
        process.exit(2);
      }
      result = validateAdapter(adapterPath);
    }

    // Output
    if (jsonFlag) {
      // For bundles, collapse to a single result entry
      if (result.artifact_type === 'bundle') {
        printJsonResult({
          valid: result.valid,
          artifact_type: 'bundle',
          protocol_version: result.protocol_version,
          schema_errors: [],
          semantic_errors: [],
          results: result.results.map(r => ({
            valid: r.valid,
            artifact_type: r.artifact_type,
            file: r.file,
            schema_errors: r.schema_errors,
            semantic_errors: r.semantic_errors,
          })),
        });
      } else {
        printJsonResult(result);
      }
    } else {
      if (result.artifact_type === 'bundle') {
        // Print bundle summary
        console.log(`Bundle: ${result.label}`);
        console.log('');
        for (const r of result.results) {
          printHumanResult(r);
        }
        // Summary line
        const total = result.results.length;
        const passed = result.results.filter(r => r.valid).length;
        console.log(`\n${passed}/${total} artifacts passed validation.`);
      } else {
        printHumanResult(result);
      }
    }

    process.exit(result.valid ? 0 : 1);
  } catch (err) {
    if (args.includes('--json')) {
      console.log(JSON.stringify({
        valid: false,
        artifact_type: null,
        protocol_version: null,
        schema_errors: [{ message: err.message }],
        semantic_errors: [],
      }, null, 2));
    } else {
      console.error(`ERROR: ${err.message}`);
    }
    process.exit(3);
  }
}

if (require.main === module) {
  main();
}

module.exports = { validateSingle, validateBundle, validateAdapter };
