# HIVE Protocol Artifact Validation CLI

A command-line tool for validating HIVE protocol artifacts against JSON Schemas and semantic rules.

## Installation

The CLI requires [Node.js](https://nodejs.org/) 18+ and uses [Ajv](https://ajv.js.org/) (JSON Schema validator) as a development dependency.

```bash
npm install --save-dev ajv
```

## Usage

### Validate a single artifact

```bash
node tools/hive-validate.js --type <artifact-type> --file <json-file>
```

### Validate a complete run bundle

```bash
node tools/hive-validate.js --bundle .hive-run
```

### Validate an adapter manifest

```bash
node tools/hive-validate.js --adapter adapters/my-adapter/adapter.json
```

### Machine-readable JSON output

Add the `--json` flag to any command:

```bash
node tools/hive-validate.js --type final-review --file final-review.json --json
```

## Exit Codes

| Code | Meaning                            |
|------|------------------------------------|
| 0    | All validations passed             |
| 1    | Schema or semantic validation failed |
| 2    | Invalid CLI usage / bad arguments  |
| 3    | File or schema could not be loaded |

## Supported Artifact Types

| Type                  | Schema File                             |
|-----------------------|-----------------------------------------|
| `run-contract`        | `schemas/v1/run-contract.schema.json`   |
| `task-graph`          | `schemas/v1/task-graph.schema.json`     |
| `role-handoff`        | `schemas/v1/role-handoff.schema.json`   |
| `evidence-ledger`     | `schemas/v1/evidence-ledger.schema.json`|
| `final-review`        | `schemas/v1/final-review.schema.json`   |
| `runtime-capabilities`| `schemas/v1/runtime-capabilities.schema.json` |
| `adapter-manifest`    | `schemas/v1/adapter-manifest.schema.json` |
| `run-manifest`        | `schemas/v1/run-manifest.schema.json`   |
| `protocol-manifest`   | `schemas/protocol-manifest.schema.json` |

## Semantic Rules

In addition to JSON Schema validation, the CLI applies these semantic rules:

| # | Rule                          | Description                                                  |
|---|-------------------------------|--------------------------------------------------------------|
| 1 | `audit-no-source-edits`       | Audit mode must not have `files_affected` populated.         |
| 2 | `audit-no-forger`             | Audit mode task graphs must not assign the "forger" role.    |
| 3 | `implementation-needs-sentinel` | Non-audit task graphs must have at least one "sentinel" task. |
| 4 | `fix-cycles-within-preset`    | `fix_cycles_used` must not exceed mode-specific limits.      |
| 5 | `complete-no-fail-verdict`    | "complete" runs cannot have FAIL/BLOCKED verdicts.           |
| 6 | `pass-no-critical-findings`   | PASS/PASS_WITH_LIMITATIONS verdicts must have no critical findings. |
| 7 | `evidence-refs-exist`         | All `evidence_refs` must resolve to existing ledger entries. |
| 8 | `test-claims-need-evidence`   | Test claims require command or test evidence entries.        |
| 9 | `dependencies-reference-real-tasks` | Task dependencies must reference existing tasks.       |
| 10 | `no-cyclic-dependencies`      | Task graphs must not contain circular dependencies.          |
| 11 | `shared-run-id`               | All artifacts in a bundle must share the same `run_id`.      |
| 12 | `compatible-protocol-versions`| Protocol version must be >= 1.0.0 and < 2.0.0.               |
| 13 | `secret-scanning`             | Warns on patterns like API keys, tokens, and private keys.   |

## Examples

### Validate protocol.json

```bash
node tools/hive-validate.js --type protocol-manifest --file protocol.json
# PASS: protocol.json conforms to HIVE Protocol 1.0.0
```

### Validate a final review

```bash
node tools/hive-validate.js --type final-review --file .hive-run/final-review.json
```

### Validate an entire run bundle

```bash
node tools/hive-validate.js --bundle .hive-run
# Bundle: .hive-run/
# PASS: manifest.json conforms to HIVE Protocol 1.0.0
# PASS: run-contract.json conforms to HIVE Protocol 1.0.0
# PASS: task-graph.json conforms to HIVE Protocol 1.0.0
# ...
# 6/6 artifacts passed validation.
```

### Pipeline use

```bash
node tools/hive-validate.js --type protocol-manifest --file protocol.json --json | jq .valid
# true
```

## Programmatic API

The CLI modules can also be used programmatically:

```javascript
const { validateArtifact } = require('./tools/load-schema');
const { validateSemantics } = require('./tools/semantic-rules');

const data = require('./path/to/artifact.json');
const schemaResult = validateArtifact('final-review', data);
const semanticErrors = validateSemantics('final-review', data);
```

## Files

| File                  | Purpose                                     |
|-----------------------|---------------------------------------------|
| `hive-validate.js`    | Main CLI entry point                        |
| `load-schema.js`      | Schema loading and Ajv compilation           |
| `semantic-rules.js`   | Semantic validation rules                    |
