# HIVE Protocol JSON Schemas

This directory contains versioned JSON Schema (draft-07) definitions for the HIVE (Hierarchical Intelligent Versatile Execution) protocol used by the `hive-mind-council` skill.

## Directory Layout

```
schemas/
├── README.md                            # This file
├── protocol-manifest.schema.json        # Schema for root protocol.json
└── v1/                                  # Protocol version 1.x schemas
    ├── definitions.schema.json          # Shared enums and type definitions
    ├── run-contract.schema.json         # Run contract (initialization)
    ├── task-graph.schema.json           # Multi-agent task decomposition
    ├── role-handoff.schema.json         # Agent-to-agent handoff records
    ├── evidence-ledger.schema.json      # Typed evidence entries
    ├── final-review.schema.json         # Final review summary
    ├── runtime-capabilities.schema.json # Runtime capability declarations
    ├── adapter-manifest.schema.json     # Adapter conformance manifests
    └── run-manifest.schema.json         # Run bundle manifests
```

## Conventions

1. **Draft-07**: All schemas target `http://json-schema.org/draft-07/schema#`.
2. **`$id`**: Each schema uses a relative `$id` matching its file path (e.g. `v1/definitions.schema.json`).
3. **`$ref`**: Cross-schema references use relative paths (e.g. `v1/definitions.schema.json#/$defs/HiveRole`). These resolve from the schema's own `$id` base URI, which aligns with the filesystem layout under `schemas/`.
4. **Shared Definitions**: The `v1/definitions.schema.json` file holds all shared enums (`HiveRole`, `ExecutionMode`, `RunStatus`, etc.) and reusable object types (`CommandEvidence`, `FileEvidence`, etc.). Other schemas reference them via `$ref`.
5. **Backward Compatibility**: Within protocol major version 1, all schemas must remain backward compatible. Adding new optional fields is allowed; removing or renaming existing fields is not.
6. **No External Dependencies**: All schemas are self-contained. No external schema packages are imported.

## Schema Relationships

```
protocol.json  ----validated-by---->  protocol-manifest.schema.json
                                          |
                                          |  (references definitions)
                                          v
                                   v1/definitions.schema.json
                                          ^
                                          |
                +-------------------------+--------------------------+
                |         |         |          |          |          |
     v1/run-contract  v1/task-graph  v1/role-handoff  v1/evidence-ledger  v1/final-review
                |         |         |          |          |          |
                +-------------------------+--------------------------+
                                          |
                          v1/runtime-capabilities.schema.json
                          v1/adapter-manifest.schema.json
                          v1/run-manifest.schema.json
```

- `run-contract`, `task-graph`, `role-handoff`, `evidence-ledger`, and `final-review` are **run artifacts** produced during a hive execution.
- `runtime-capabilities` documents what a runtime can do.
- `adapter-manifest` declares an adapter's conformance to the protocol.
- `run-manifest` indexes a completed run bundle.
