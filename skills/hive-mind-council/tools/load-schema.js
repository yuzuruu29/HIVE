/**
 * load-schema.js — Schema loading using Ajv
 *
 * Loads all HIVE Protocol JSON Schema files, compiles them with Ajv (draft-07),
 * and exports a validateArtifact(type, data) function.
 *
 * Schema $ref paths resolve from the repository root using $id values.
 */

const Ajv = require('ajv');
const path = require('path');
const fs = require('fs');

// Resolve the schemas directory relative to this file (tools/../schemas)
const SCHEMAS_DIR = path.resolve(__dirname, '..', 'schemas');
const V1_DIR = path.join(SCHEMAS_DIR, 'v1');

// Map artifact type names to their schema $id values
const SCHEMA_MAP = {
  'run-contract': 'v1/run-contract.schema.json',
  'task-graph': 'v1/task-graph.schema.json',
  'role-handoff': 'v1/role-handoff.schema.json',
  'evidence-ledger': 'v1/evidence-ledger.schema.json',
  'final-review': 'v1/final-review.schema.json',
  'runtime-capabilities': 'v1/runtime-capabilities.schema.json',
  'adapter-manifest': 'v1/adapter-manifest.schema.json',
  'run-manifest': 'v1/run-manifest.schema.json',
  'protocol-manifest': 'protocol-manifest.schema.json',
};

// ---------------------------------------------------------------------------
// Initialize Ajv and register all schemas
// ---------------------------------------------------------------------------

const ajv = new Ajv({
  // Use draft-07 dialect (default, but explicit)
  strict: false,
  // Suppress warnings about unknown formats like "date-time"
  // which are not critical for structural validation
  logger: false,
});

/** Load a JSON file and return the parsed object. */
function loadJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to load schema file "${filePath}": ${err.message}`);
  }
}

/**
 * Load and register all schema files with Ajv.
 * Returns the Ajv instance ready for validation.
 */
function registerAllSchemas() {
  // 1. Load definitions first — everything else $refs into it
  const defsPath = path.join(V1_DIR, 'definitions.schema.json');
  const defsSchema = loadJSON(defsPath);
  ajv.addSchema(defsSchema);

  // 2. Load all v1/*.schema.json (except definitions, which is already loaded)
  const v1Files = fs.readdirSync(V1_DIR)
    .filter(f => f.endsWith('.schema.json') && f !== 'definitions.schema.json')
    .sort();

  for (const file of v1Files) {
    const schema = loadJSON(path.join(V1_DIR, file));
    ajv.addSchema(schema);
  }

  // 3. Load protocol-manifest.schema.json from schemas/ root
  const protoPath = path.join(SCHEMAS_DIR, 'protocol-manifest.schema.json');
  const protoSchema = loadJSON(protoPath);
  ajv.addSchema(protoSchema);
}

// Register all schemas on module load
registerAllSchemas();

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Validate an artifact against its JSON Schema.
 *
 * @param {string} type  — Artifact type name (see SCHEMA_MAP keys)
 * @param {object} data  — Parsed JSON artifact to validate
 * @returns {{ valid: boolean, errors: Array<object> }}
 */
function validateArtifact(type, data) {
  const schemaId = SCHEMA_MAP[type];
  if (!schemaId) {
    return {
      valid: false,
      errors: [{ message: `Unknown artifact type "${type}". Supported types: ${Object.keys(SCHEMA_MAP).join(', ')}` }],
    };
  }

  const validate = ajv.getSchema(schemaId);
  if (!validate) {
    return {
      valid: false,
      errors: [{ message: `Could not find compiled schema for "${schemaId}". Schema may have failed to register.` }],
    };
  }

  const valid = validate(data);
  return {
    valid,
    errors: valid ? [] : (validate.errors || []),
  };
}

module.exports = { validateArtifact, SCHEMA_MAP };
